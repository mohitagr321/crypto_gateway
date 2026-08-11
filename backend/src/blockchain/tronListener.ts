/**
 * TRC20 / Tron listener (standalone: `node dist/blockchain/tronListener.js`).
 *
 * The BEP20 listener (listener.ts) scans block ranges for Transfer logs. That is
 * impossible on Tron: USDT is the busiest contract on the network and TronGrid
 * exposes no "give me this token's Transfers in block range X..Y" query. So this
 * listener is ADDRESS-DRIVEN instead of block-driven:
 *
 *   1. Refresh the set of active TRC20 deposit addresses from Postgres.
 *   2. For each, poll TronGrid:
 *        GET /v1/accounts/{addr}/transactions/trc20
 *            ?only_to=true&only_confirmed=true&contract_address=<USDT>
 *      returning inbound, SOLIDIFIED USDT transfers to that address.
 *   3. Resolve each tx's block number via getTransactionInfo (the list endpoint
 *      omits it), record it, and drive the payment state machine identically to
 *      the BEP20 path: waiting -> confirming -> confirmed -> (sweep).
 *
 * ============================ TWO TICKS, NOT ONE =============================
 * Step 2 is O(watched addresses) HTTP requests and step 3's promotion half is
 * pure SQL over rows step 2 already wrote. They used to be one sequential pass,
 * which coupled them in the worst possible direction: with enough open payments
 * the address scan overran its interval, and because promotion was the LAST
 * statement of the pass, confirmations, `payment.confirmed` webhooks and sweep
 * enqueues fell behind by exactly as much. They are now two independent
 * intervals with independent guards, so settlement keeps advancing while a long
 * scan is in flight — and a TronGrid outage on the block-head read no longer
 * stops deposit DETECTION as well.
 *
 * The scan itself runs a bounded window of addresses in parallel against a
 * per-pass deadline, least-recently-scanned first. See scanAddresses().
 *
 * FINALITY / REORGS: `only_confirmed=true` returns transactions in *solidified*
 * blocks, which on Tron are irreversible. Combined with a healthy
 * TRON_REQUIRED_CONFIRMATIONS (~19), a recorded TRC20 deposit never needs the
 * reorg-revert dance the BSC listener performs — solidified is final. We still
 * track confirmations = nowBlock - txBlock purely so merchants see a progress
 * count consistent with BEP20.
 *
 * IDEMPOTENCY: every write is guarded exactly as on the BEP20 side —
 * blockchain_transactions has UNIQUE (tx_hash, log_index) and status transitions
 * carry WHERE guards, so overlapping polls and restarts are safe no-ops.
 *
 * This process is a NO-OP unless TRON_ENABLED=true; it logs and idles otherwise,
 * so it is always safe to add to the process supervisor.
 */
import { config } from '../config/env';
import { logger } from '../config/logger';
import { pool, query, queryOne } from '../db/pool';
import { sweepQueue, SweepJob } from '../workers/queues';
import { enqueueWebhook } from '../services/webhookService';
import { fromTronBaseUnits, sunToTrx, toBigInt, tronAddressFromHex, tronClient } from './tron';
import { Asset, nativeAssetFor, tokenAssetsFor } from './assets';
import { recordUnexpectedDeposit } from '../services/unexpectedDepositService';

/**
 * SQL for a payment's received total: the sum of its non-reorged incoming
 * transfers. Used instead of assigning a single transfer's value — see
 * recordIncoming for why that was wrong.
 */
const RECEIVED_SUM = `COALESCE((
              SELECT SUM(bt.amount)
                FROM blockchain_transactions bt
               WHERE bt.payment_id = payments.id
                 AND bt.direction = 'incoming'
                 AND bt.status <> 'reorged'
            ), 0)`;

const POLL_INTERVAL_MS = 5_000;
const ADDRESS_REFRESH_MS = 30_000;

/**
 * Deadline on every outbound TronGrid call.
 *
 * These used to be bare `await fetch(...)`. undici applies no total-request
 * timeout, so one socket that opened and then went quiet held the pass open
 * forever; the in-flight guard on the tick then meant the listener simply stopped
 * polling — silently, with no log line — while deposits kept arriving. This
 * mirrors the 15s deadline bitcoin.ts has always had on Esplora.
 */
const HTTP_TIMEOUT_MS = 15_000;

/**
 * How many addresses are scanned concurrently.
 *
 * Deliberately a small window rather than a Promise.all over the whole watch
 * set: TronGrid rate-limits hard, and firing thousands of requests at once earns
 * a 429 storm that detects nothing at all. The free quota without an API key is
 * small enough that even a modest window is too much, so the width is keyed off
 * whether a key is configured.
 */
const SCAN_CONCURRENCY = config.tron.apiKey ? 8 : 3;

/**
 * How long one address-scan pass may run before it stops and hands over to the
 * next tick.
 *
 * The deadline is what keeps the listener responsive when the watch set is
 * larger than one pass can cover: rather than a single pass running for minutes
 * (blocking every subsequent tick behind the `scanning` guard), each pass does a
 * bounded amount of work and the NEXT one picks up where this one left off —
 * see the least-recently-scanned ordering in scanAddresses().
 */
const PASS_DEADLINE_MS = POLL_INTERVAL_MS * 6;

/**
 * How far back to ask TronGrid for transfers to a given address.
 *
 * A FIXED window is wrong here: if this process is down longer than the window,
 * a deposit that solidified during the outage is never queried again and the
 * payment stays stuck in `waiting` with the merchant's funds sitting unswept at
 * the deposit address. So the floor is derived per address from its payment's
 * own created_at — a payment can never have received funds before it existed —
 * with an hour of slack for clock skew.
 *
 * MAX_LOOKBACK_MS is only a backstop against an unbounded query for a very old
 * row that somehow never left an active status.
 */
const LOOKBACK_SLACK_MS = 60 * 60 * 1000; // 1h
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30d

/** Watched deposit addresses -> the epoch ms floor to query from. */
const depositAddresses = new Map<string, number>();

/**
 * Address -> epoch ms of its last completed scan.
 *
 * Only used to order the next pass. Pruned to the watch set on every pass, so it
 * cannot outgrow `depositAddresses`.
 */
const lastScannedAt = new Map<string, number>();

interface TrongridTrc20Tx {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string; // base units (6dp) as a decimal string
  type: string; // 'Transfer'
  token_info?: { address?: string; decimals?: number };
}

/**
 * A row from the plain `/transactions` endpoint — the NATIVE (TRX) feed.
 *
 * A different endpoint from the TRC20 one above, and a better-shaped one: it
 * carries `blockNumber` inline, so a native transfer needs no follow-up
 * getTransactionInfo call to compute confirmations (the TRC20 list omits it and
 * costs one extra round-trip per transfer).
 *
 * It also exposes `internal_transactions`, which is TRX moved BY A CONTRACT.
 * Those are invisible to the BEP20 listener's equivalent block scan — public BSC
 * RPCs expose no trace API — so Tron detection is strictly better here, not by
 * design but because TronGrid happens to index it.
 */
interface TrongridNativeTx {
  txID: string;
  blockNumber?: number;
  block_timestamp: number;
  ret?: Array<{ contractRet?: string }>;
  raw_data: {
    contract: Array<{
      type: string; // 'TransferContract' for a native send
      parameter: {
        value: {
          amount?: number;
          owner_address?: string; // hex41 form
          to_address?: string; // hex41 form
        };
      };
    }>;
  };
  internal_transactions?: Array<{
    hash?: string;
    caller_address?: string;
    transferTo_address?: string;
    callValueInfo?: Array<{ callValue?: number }>;
    rejected?: boolean;
  }>;
}

/** One inbound native transfer, normalised out of either shape above. */
interface NativeTransfer {
  txId: string;
  blockNumber: number;
  from: string;
  to: string;
  amountSun: bigint;
}

async function refreshDepositAddresses(): Promise<void> {
  // Oldest created_at per address: an address is normally used by exactly one
  // payment, but taking the min is the safe reading if it were ever reused.
  const rows = await query<{ address: string; created_at: string }>(
    `SELECT deposit_address AS address, MIN(created_at) AS created_at
       FROM payments
      WHERE status IN ('waiting', 'confirming', 'partial')
        AND network = 'TRC20'
      GROUP BY deposit_address`,
  );
  depositAddresses.clear();
  for (const r of rows) {
    const createdMs = new Date(r.created_at).getTime();
    const floor = Number.isNaN(createdMs) ? Date.now() - MAX_LOOKBACK_MS : createdMs;
    depositAddresses.set(r.address, floor - LOOKBACK_SLACK_MS);
  }
  logger.info({ count: depositAddresses.size }, 'refreshed TRC20 deposit address watch set');
}

/**
 * One TronGrid GET, aborted at HTTP_TIMEOUT_MS.
 *
 * The abort covers the body read as well as the headers, which matters: a
 * response that starts and then stalls mid-stream is the same unbounded hang as
 * one that never answers.
 */
async function trongrid<T>(url: string, what: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: config.tron.apiKey ? { 'TRON-PRO-API-KEY': config.tron.apiKey } : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`TronGrid ${res.status} ${res.statusText} for ${what}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bound a promise that cannot be aborted from the outside — tronweb builds its
 * own HTTP client and exposes no signal.
 *
 * The underlying request is left to finish and its result discarded. That is
 * accepted: the point is not to cancel the work, it is that one stuck call can
 * no longer hold the whole pass open.
 */
async function withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} exceeded ${HTTP_TIMEOUT_MS}ms`)),
          HTTP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * TronGrid REST call for inbound, solidified TRC20 transfers of ONE asset to one
 * address.
 *
 * `contract_address` is a single value in this endpoint, so multi-asset means
 * one call per (address, asset) rather than a merged query — which is why the
 * caller loops over assets rather than filtering client-side. Filtering
 * server-side keeps the response small and stays inside TronGrid's rate limit.
 */
async function fetchInboundTransfers(
  address: string,
  sinceMs: number,
  asset: Asset,
): Promise<TrongridTrc20Tx[]> {
  const base = config.tron.fullHost.replace(/\/+$/, '');
  const minTs = Math.max(sinceMs, Date.now() - MAX_LOOKBACK_MS);
  const url =
    `${base}/v1/accounts/${address}/transactions/trc20` +
    `?only_to=true&only_confirmed=true&limit=50&order_by=block_timestamp,desc` +
    `&contract_address=${asset.contract}&min_timestamp=${minTs}`;

  const body = await trongrid<{ data?: TrongridTrc20Tx[]; success?: boolean }>(
    url,
    `${address} (${asset.symbol})`,
  );
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * Inbound NATIVE (TRX) transfers to one address, from TronGrid's plain
 * transaction feed.
 *
 * Returns both top-level `TransferContract` sends and any successful internal
 * transfers that moved TRX to this address. Reverted transactions are dropped
 * here rather than downstream — a failed transfer moved nothing, and recording
 * it would credit a payment that was never paid.
 *
 * ====================== ONE ROW PER TRANSACTION, NOT PER LEG =================
 * A single Tron transaction can move TRX to the same address several times: a
 * top-level TransferContract plus any number of internal transfers forwarded by
 * a contract. Every leg carries the same txID, and recordIncomingNative files
 * native transfers under the sentinel log_index -1 — so under
 * UNIQUE (tx_hash, log_index) the second and later legs collided with the first,
 * and because the ON CONFLICT clause updates only `block_number`, their VALUE
 * was discarded in silence. A payment paid by a batching or forwarding contract
 * was credited with one leg out of N and then held as `partial` forever.
 *
 * So the legs of one transaction are SUMMED into one transfer here. That keeps
 * exactly one row per (tx_hash, -1) — no new sentinel values, no migration, and
 * no change to the settled-txid skip in scanAddress, which is keyed on txid —
 * while crediting the full amount that actually arrived. The cost is per-leg
 * provenance: `from` is the first leg's sender.
 */
async function fetchInboundNative(
  address: string,
  sinceMs: number,
): Promise<NativeTransfer[]> {
  const base = config.tron.fullHost.replace(/\/+$/, '');
  const minTs = Math.max(sinceMs, Date.now() - MAX_LOOKBACK_MS);
  const url =
    `${base}/v1/accounts/${address}/transactions` +
    `?only_to=true&only_confirmed=true&limit=50&order_by=block_timestamp,desc` +
    `&min_timestamp=${minTs}`;

  const body = await trongrid<{ data?: TrongridNativeTx[] }>(url, `${address} (native)`);
  const rows = Array.isArray(body.data) ? body.data : [];

  // Keyed by txID; insertion-ordered, so the returned order still follows the
  // feed's.
  const byTx = new Map<string, NativeTransfer>();
  // EVERY LEG IS ADDED AT MOST ONCE, keyed by its position in the transaction.
  //
  // Summing is not idempotent the way the old one-row-per-leg return was: that
  // shape leaned on ON CONFLICT (tx_hash, log_index) to collapse a repeat into
  // the same single row, so a feed that listed one transaction twice cost
  // nothing. A sum would instead credit it twice, and an OVER-credit marks an
  // invoice paid on money that never arrived — the opposite direction of the
  // bug this aggregation exists to fix, and the worse one. The leg key restores
  // that idempotency inside the pass; identical legs of a repeated record
  // collapse, genuinely distinct legs (different indexes) still sum.
  const seenLegs = new Set<string>();
  const add = (legKey: string, t: NativeTransfer): void => {
    if (seenLegs.has(legKey)) return;
    seenLegs.add(legKey);
    const existing = byTx.get(t.txId);
    if (existing) existing.amountSun += t.amountSun;
    else byTx.set(t.txId, t);
  };

  for (const tx of rows) {
    if (!tx.blockNumber) continue; // not in a block yet
    // A reverted transaction moved nothing. contractRet is absent on some very
    // old rows, so treat only an explicit non-SUCCESS as a failure.
    const ret = tx.ret?.[0]?.contractRet;
    if (ret && ret !== 'SUCCESS') continue;

    // ---- top-level native send ----
    const contract = tx.raw_data?.contract?.[0];
    if (contract?.type === 'TransferContract') {
      const v = contract.parameter?.value ?? {};
      const to = tronAddressFromHex(v.to_address ?? '');
      const amount = BigInt(Math.trunc(v.amount ?? 0));
      if (to === address && amount > 0n) {
        add(`${tx.txID}:top`, {
          txId: tx.txID,
          blockNumber: tx.blockNumber,
          from: tronAddressFromHex(v.owner_address ?? ''),
          to,
          amountSun: amount,
        });
      }
    }

    // ---- TRX forwarded by a contract ----
    const internals = tx.internal_transactions ?? [];
    for (let i = 0; i < internals.length; i += 1) {
      const it = internals[i];
      if (it.rejected) continue;
      const to = tronAddressFromHex(it.transferTo_address ?? '');
      if (to !== address) continue;
      const amount = (it.callValueInfo ?? []).reduce(
        (acc, c) => acc + BigInt(Math.trunc(c.callValue ?? 0)),
        0n,
      );
      if (amount <= 0n) continue;
      // The index, not `it.hash`: the hash is optional on this feed and several
      // internal transfers of one transaction can share it.
      add(`${tx.txID}:int:${i}`, {
        txId: tx.txID,
        blockNumber: tx.blockNumber,
        from: tronAddressFromHex(it.caller_address ?? ''),
        to,
        amountSun: amount,
      });
    }
  }
  return Array.from(byTx.values());
}

/**
 * Resolve the block number a Tron tx landed in. The list endpoint omits it, but
 * confirmations are computed against it, so we fetch the receipt once per tx.
 */
async function blockNumberOf(txHash: string): Promise<number | null> {
  try {
    const info = (await withDeadline(
      tronClient().trx.getTransactionInfo(txHash),
      `getTransactionInfo(${txHash})`,
    )) as {
      blockNumber?: number;
      receipt?: { result?: string };
    };
    if (!info || !info.blockNumber) return null;
    // A reverted transfer must never count as a deposit.
    if (info.receipt?.result && info.receipt.result !== 'SUCCESS') return null;
    return info.blockNumber;
  } catch (err) {
    logger.warn({ err, txHash }, 'tron: block lookup failed');
    return null;
  }
}

/**
 * Of `txIds`, the ones already fully accounted for: a blockchain_transactions
 * row exists for (tx, logIndex) AND its payment's `amount_received` already
 * includes it.
 *
 * TronGrid keeps returning a deposit for as long as it falls inside the query
 * window, so without this the pass paid one getTransactionInfo round trip per
 * known transfer, every five seconds, for the entire life of the payment — for
 * an answer that cannot change once a block is solidified.
 *
 * The `amount_received` term is not decoration. recordTransfer writes the
 * transaction row and the payment total as two separate statements, so a crash
 * between them leaves a recorded transfer the payment does not count. Skipping
 * on the existence of the row alone would freeze that gap permanently and
 * underpay the invoice for good; requiring the total to already match means such
 * a payment is simply re-recorded on the next pass and heals itself.
 *
 * Scoped to `asset` as well. TRC20 rows all carry log_index 0, so without that
 * term a recorded USDT transfer would answer for a USDC one sharing its txid —
 * and the USDC leg would be skipped before recordTransfer could file it as an
 * unexpected deposit, which is the only record an operator has of a wrong-asset
 * arrival.
 */
async function settledTxIds(
  txIds: string[],
  logIndex: number,
  asset: string,
): Promise<Set<string>> {
  if (txIds.length === 0) return new Set<string>();
  const rows = await query<{ tx_hash: string }>(
    `SELECT bt.tx_hash
       FROM blockchain_transactions bt
       JOIN payments p ON p.id = bt.payment_id
      WHERE bt.network = 'TRC20'
        AND bt.direction = 'incoming'
        AND bt.log_index = $2
        AND bt.asset = $3
        AND bt.tx_hash = ANY($1::text[])
        AND p.amount_received = COALESCE((
              SELECT SUM(x.amount)
                FROM blockchain_transactions x
               WHERE x.payment_id = p.id
                 AND x.direction = 'incoming'
                 AND x.status <> 'reorged'
            ), 0)`,
    [txIds, logIndex, asset],
  );
  return new Set(rows.map((r) => r.tx_hash));
}

/**
 * Record an inbound TRC20 transfer against a payment (idempotent) and move it
 * waiting -> confirming. Mirrors recordIncoming() on the BEP20 side.
 */
async function recordTransfer(params: {
  txId: string;
  blockNumber: number;
  from: string;
  to: string;
  amountHuman: string;
  asset: Asset;
  /**
   * 0 for TRC20 transfers, -1 for NATIVE ones. A native TRX send has no log at
   * all, and the sentinel keeps it distinct under UNIQUE (tx_hash, log_index) —
   * one transaction can both trigger a contract and move TRX internally, and
   * without this they would collide and one would be silently dropped.
   */
  logIndex: number;
}): Promise<void> {
  const { txId, blockNumber, from, to, amountHuman, asset, logIndex } = params;

  // The asset clause matters as much here as on BEP20: a customer can send any
  // supported TRC20 token — or plain TRX — to a deposit address, and crediting a
  // USDC transfer against a USDT payment would put the wrong asset into a
  // withdrawable balance.
  const payment = await queryOne<{ id: string; status: string }>(
    `SELECT id, status
       FROM payments
      WHERE deposit_address = $1
        AND status IN ('waiting', 'confirming', 'partial')
        AND network = 'TRC20'
        AND asset = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [to, asset.symbol],
  );
  if (!payment) {
    // Same reasoning as the BEP20 listener: our address, wrong asset. Recorded
    // for recovery rather than ignored or mis-credited.
    await recordUnexpectedDeposit({
      network: 'TRC20',
      asset,
      amountHuman,
      depositAddress: to,
      txHash: txId,
      logIndex,
    });
    return;
  }

  // The RETURNING clause is a COLLAPSE DETECTOR, not bookkeeping.
  //
  // On conflict this statement updates only `block_number`, so a second transfer
  // arriving under the same (tx_hash, log_index) leaves the first row's amount
  // standing and its own value is dropped without a trace. The native path can no
  // longer produce that (fetchInboundNative sums a transaction's legs into one
  // transfer), but the token path still can in principle: every TRC20 row carries
  // log_index 0, so two different tokens moved to one address in ONE transaction
  // share a key. `amount` is not in the DO UPDATE list, so the value returned here
  // is the row as it now stands — comparing it to what we tried to write says
  // whether we just lost money quietly.
  const written = await query<{ amount: string; amount_differs: boolean }>(
    `INSERT INTO blockchain_transactions
       (payment_id, direction, tx_hash, from_address, to_address, amount, token,
        network, block_number, confirmations, status, log_index, asset)
     VALUES ($1, 'incoming', $2, $3, $4, $5, $7, 'TRC20', $6, 0, 'pending', $8, $7)
     ON CONFLICT (tx_hash, log_index)
     DO UPDATE SET block_number = EXCLUDED.block_number
     RETURNING amount, (amount IS DISTINCT FROM $5::numeric) AS amount_differs`,
    [payment.id, txId, from, to, amountHuman, blockNumber, asset.symbol, logIndex],
  );
  if (written[0]?.amount_differs) {
    logger.error(
      {
        paymentId: payment.id,
        txHash: txId,
        logIndex,
        asset: asset.symbol,
        recorded: written[0].amount,
        arriving: amountHuman,
      },
      'TRC20 transfer collides with an existing row on (tx_hash, log_index) but ' +
        'carries a different amount — one of the two is NOT credited. Recover it ' +
        'by HD index; do not assume amount_received is complete.',
    );
  }

  // Recomputed from the transaction rows rather than set to this transfer's
  // value — see the same code in listener.ts for why. A customer paying a TRC20
  // invoice in two transfers previously had the first silently overwritten.
  await query(
    `UPDATE payments
        SET amount_received = ${RECEIVED_SUM},
            tx_hash = $2,
            status = CASE WHEN status = 'waiting' THEN 'confirming' ELSE status END
      WHERE id = $1
        AND status IN ('waiting', 'confirming', 'partial')`,
    [payment.id, txId],
  );

  logger.info(
    { paymentId: payment.id, txHash: txId, amount: amountHuman, asset: asset.symbol },
    'incoming Tron transfer recorded (confirming)',
  );

  if (payment.status === 'waiting') {
    enqueueWebhook({ paymentId: payment.id, event: 'payment.confirming' }).catch((err) =>
      logger.warn({ err, paymentId: payment.id }, 'confirming webhook enqueue failed'),
    );
  }
}

/** TRC20 token transfer -> the shared recorder. */
async function recordIncoming(
  tx: TrongridTrc20Tx,
  blockNumber: number,
  asset: Asset,
): Promise<void> {
  return recordTransfer({
    txId: tx.transaction_id,
    blockNumber,
    from: tx.from,
    to: tx.to,
    // Tron assets differ in decimals (USDT/USDC 6, USDD 18), so scale by the
    // asset in hand rather than the chain default.
    amountHuman: fromTronBaseUnits(toBigInt(tx.value), asset.decimals),
    asset,
    // Tron txids are unique per token transfer and this endpoint has no log
    // index, so 0 satisfies UNIQUE (tx_hash, log_index).
    logIndex: 0,
  });
}

/** Native TRX transfer -> the shared recorder. */
async function recordIncomingNative(
  transfer: NativeTransfer,
  asset: Asset,
): Promise<void> {
  return recordTransfer({
    txId: transfer.txId,
    blockNumber: transfer.blockNumber,
    from: transfer.from,
    to: transfer.to,
    amountHuman: sunToTrx(transfer.amountSun),
    asset,
    logIndex: -1,
  });
}

/**
 * Update confirmations from the current head and promote confirmed payments,
 * enqueueing the sweep + webhook. Scoped to network='TRC20'. Mirrors the BEP20
 * updateConfirmationsAndPromote(); each guard fires exactly once.
 */
async function updateConfirmationsAndPromote(nowBlock: number): Promise<void> {
  await query(
    `UPDATE blockchain_transactions
        SET confirmations = GREATEST(0, $1 - block_number)
      WHERE direction = 'incoming'
        AND status = 'pending'
        AND network = 'TRC20'
        AND block_number IS NOT NULL`,
    [nowBlock],
  );

  await query(
    `UPDATE payments p
        SET confirmations = GREATEST(0, $1 - bt.block_number)
       FROM blockchain_transactions bt
      WHERE bt.payment_id = p.id
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = 'TRC20'
        AND p.status IN ('confirming', 'partial')`,
    [nowBlock],
  );

  // `fully_paid`: confirmation DEPTH and payment SUFFICIENCY are independent
  // questions, and this only ever asked the first — see the note in
  // evmListener.ts. Any nonzero TRC20 transfer that got deep enough confirmed
  // the whole invoice.
  //
  // `partial` IS SELECTED HERE, not `confirming` alone, and that is what makes
  // the underpayment hold recoverable rather than terminal — same reasoning as
  // evmListener.ts, and it has to be the same on every chain or a topped-up
  // TRC20 invoice is stranded where a BEP20 one settles. recordTransfer accepts
  // `partial` in its WHERE clause and files the top-up as a fresh `pending`
  // transfer row, so the money arrives and amount_received grows past `amount` —
  // but with `confirming` alone nothing could ever select the payment again. It
  // would never be promoted, never swept, never expired (processExpiry only
  // touches `waiting`), and would show on the merchant's balance strip as
  // pending forever. A fully-paid invoice whose funds sit at the deposit address
  // with nothing that can move them is worse than the underpayment it replaced.
  //
  // Re-checking a settled `partial` costs nothing: the partial branch below
  // marks its incoming rows `confirmed`, so a payment with no NEW money has no
  // `pending` row left to join against and never reappears here.
  const ready = await query<{ id: string; fully_paid: boolean }>(
    `SELECT p.id, (p.amount_received >= p.amount) AS fully_paid
       FROM payments p
       JOIN blockchain_transactions bt ON bt.payment_id = p.id
      WHERE p.status IN ('confirming', 'partial')
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = 'TRC20'
        AND ($1 - bt.block_number) >= p.required_confirmations`,
    [nowBlock],
  );

  for (const p of ready) {
    // UNDERPAID: hold as `partial`. No payment.confirmed, no sweep. The payment
    // stays open for a top-up and is never expired out from under the funds.
    if (!p.fully_paid) {
      // `amount_received < amount` is re-tested HERE, inside the write, and not
      // merely trusted from the SELECT above. Promotion used to be the tail of
      // the address scan, so nothing could record a transfer between the two;
      // now that the two are separate ticks, a top-up landing in that window
      // would be read as underpaid and the (by then fully paid) invoice would be
      // frozen as `partial` — never confirmed, never swept. Losing this race is
      // harmless: zero rows means the payment is already covered, its transfer
      // rows are still `pending`, and the next tick promotes it properly.
      const marked = await query<{ id: string; amount: string; amount_received: string }>(
        `UPDATE payments SET status = 'partial'
          WHERE id = $1 AND status IN ('confirming', 'partial')
            AND amount_received < amount
          RETURNING id, amount, amount_received`,
        [p.id],
      );
      if (marked.length === 0) continue;

      await query(
        `UPDATE blockchain_transactions SET status = 'confirmed'
          WHERE payment_id = $1 AND direction = 'incoming' AND status = 'pending'
            AND network = 'TRC20'`,
        [p.id],
      );

      logger.warn(
        { paymentId: p.id, expected: marked[0].amount, received: marked[0].amount_received },
        'TRC20 payment underpaid — held as partial, not confirmed, not swept',
      );
      continue;
    }

    // Promote confirming/partial -> confirmed, guarded so it fires exactly once.
    // `partial` is included because that is precisely the topped-up case: the
    // customer covered the shortfall, so the hold is released and the payment
    // settles down the ordinary path — webhook, sweep, payout.
    const promoted = await query<{ id: string }>(
      `UPDATE payments SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1 AND status IN ('confirming', 'partial') RETURNING id`,
      [p.id],
    );
    if (promoted.length === 0) continue;

    await query(
      `UPDATE blockchain_transactions SET status = 'confirmed'
        WHERE payment_id = $1 AND direction = 'incoming' AND status = 'pending'
          AND network = 'TRC20'`,
      [p.id],
    );

    logger.info({ paymentId: p.id }, 'TRC20 payment confirmed');

    try {
      await enqueueWebhook({ paymentId: p.id, event: 'payment.confirmed' });
    } catch (err) {
      logger.error({ err, paymentId: p.id }, 'failed to enqueue confirmed webhook');
    }
    try {
      await sweepQueue.add('sweep', { paymentId: p.id } as SweepJob, {
        jobId: `sweep-${p.id}`,
      });
    } catch (err) {
      logger.error({ err, paymentId: p.id }, 'failed to enqueue sweep job');
    }
  }
}

/**
 * Everything one watched address costs: the native feed plus one TRC20 feed per
 * enabled token.
 *
 * Never throws. A single address that 429s, times out or returns garbage is
 * logged and abandoned for this pass only; it still counts as scanned for the
 * ordering, so it rotates to the back and is retried after the rest of the watch
 * set. Deliberate: a permanently failing address must not be allowed to sit at
 * the head of every pass and consume the deadline that healthy addresses need.
 */
async function scanAddress(
  address: string,
  sinceMs: number,
  trcAssets: Asset[],
  native: Asset | undefined,
): Promise<void> {
  // ---- Native TRX: one call per address, not per (address, asset) ----
  // The plain transaction feed is not filtered by contract, so a single
  // request covers it — and it carries blockNumber inline, so unlike the
  // token path below there is no follow-up receipt lookup per transfer.
  if (native) {
    try {
      const transfers = await fetchInboundNative(address, sinceMs);
      const settled = await settledTxIds(
        transfers.map((t) => t.txId),
        -1,
        native.symbol,
      );
      for (const t of transfers) {
        if (settled.has(t.txId)) continue;
        await recordIncomingNative(t, native);
      }
    } catch (err) {
      logger.warn({ err, address }, 'tron: fetch inbound native transfers failed; will retry');
    }
  }

  for (const asset of trcAssets) {
    try {
      const transfers = (await fetchInboundTransfers(address, sinceMs, asset)).filter(
        (t) => t.type === 'Transfer' && t.to === address, // the `to` test is defensive
      );
      const settled = await settledTxIds(
        transfers.map((t) => t.transaction_id),
        0,
        asset.symbol,
      );
      for (const t of transfers) {
        if (settled.has(t.transaction_id)) continue;
        const blockNumber = await blockNumberOf(t.transaction_id);
        if (blockNumber === null) continue; // not solidified yet, or reverted
        await recordIncoming(t, blockNumber, asset);
      }
    } catch (err) {
      // Skip only THIS asset for this address; the others still get scanned.
      logger.warn(
        { err, address, asset: asset.symbol },
        'tron: fetch inbound transfers failed; will retry',
      );
    }
  }
}

/**
 * Run `work` over `items`, at most `limit` at a time, stopping once `deadline`
 * has passed. Returns how many items were taken.
 *
 * A worker never propagates a failure: the whole purpose of the pool is that no
 * one address can stall or abort the scan, and a rejected worker would abort the
 * Promise.all and leave the remaining addresses unscanned.
 */
async function runPool<T>(
  items: T[],
  limit: number,
  deadline: number,
  work: (item: T) => Promise<void>,
): Promise<number> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length && Date.now() < deadline) {
      const item = items[cursor++];
      try {
        await work(item);
      } catch (err) {
        logger.warn({ err }, 'tron: address scan failed; will retry next pass');
      }
    }
  });
  await Promise.all(workers);
  return cursor;
}

/**
 * One address-scan pass over the watch set.
 *
 * This used to be a plain sequential `for (const [address] of depositAddresses)`
 * with an `await` per address per asset. Pass duration therefore grew linearly
 * with the number of open payments, and since the watch set is roughly
 * creation-rate x PAYMENT_EXPIRY_MINUTES, at volume a pass took longer than the
 * expiry window itself: the expiry worker flipped a payment to `expired` before
 * this listener had ever polled its address, refreshDepositAddresses then
 * dropped it, and a real deposit sitting at that address was never seen at all.
 */
async function scanAddresses(): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + PASS_DEADLINE_MS;

  // Snapshot BEFORE any I/O. refreshDepositAddresses runs on its own 30s timer
  // and does clear() + set(), and a Map being iterated across an await does not
  // survive that cleanly — the iterator skips the emptied entries and walks into
  // the newly appended ones instead. Any pass longer than the refresh interval
  // was therefore scanning a garbled subset and could be extended without bound.
  const snapshot = Array.from(depositAddresses.entries());

  // Forget addresses that have left the watch set, then scan least-recently-
  // scanned first. Under load a pass cannot get through every address before its
  // deadline, and iterating in map order would restart at the head every time —
  // starving the tail, which is precisely where the oldest payments (the ones
  // closest to expiry) live. Ordering by last scan makes the pool round-robin.
  for (const address of lastScannedAt.keys()) {
    if (!depositAddresses.has(address)) lastScannedAt.delete(address);
  }
  snapshot.sort((a, b) => (lastScannedAt.get(a[0]) ?? 0) - (lastScannedAt.get(b[0]) ?? 0));

  // TronGrid's trc20 endpoint filters by a SINGLE contract, so this is one call
  // per (address, asset). That is O(addresses x assets) requests per pass, which
  // is why the asset list should stay short on Tron — TronGrid rate-limits hard
  // without an API key.
  const trcAssets = tokenAssetsFor('TRC20');
  // Native TRX, when accepted. Undefined leaves the native branch inert.
  const native = nativeAssetFor('TRC20');

  const scanned = await runPool(
    snapshot,
    SCAN_CONCURRENCY,
    deadline,
    async ([address, sinceMs]) => {
      await scanAddress(address, sinceMs, trcAssets, native);
      lastScannedAt.set(address, Date.now());
    },
  );

  const passMs = Date.now() - startedAt;
  // The ratio that predicts stranded deposits: once a full sweep of the watch
  // set approaches the payment expiry window, deposits start expiring before
  // they are ever polled. A quarter of the window is the alarm, not the limit.
  const budgetMs = (config.paymentExpiryMinutes * 60_000) / 4;
  const sweepMs = scanned > 0 ? (passMs * snapshot.length) / scanned : passMs;
  if (scanned < snapshot.length || sweepMs > budgetMs) {
    logger.error(
      { passMs, sweepMs: Math.round(sweepMs), scanned, watching: snapshot.length, budgetMs },
      'TRC20 address scan is falling behind — deposits may be detected late',
    );
  } else {
    logger.debug({ passMs, watching: snapshot.length }, 'TRC20 address scan complete');
  }
}

/**
 * Confirmation + promotion tick. Reads the chain head itself rather than being
 * handed one by the address scan, because it no longer runs inside it.
 */
async function promoteOnce(): Promise<void> {
  const block = await withDeadline(tronClient().trx.getCurrentBlock(), 'getCurrentBlock');
  const nowBlock = Number(
    (block as { block_header?: { raw_data?: { number?: number } } })?.block_header?.raw_data
      ?.number ?? 0,
  );
  if (!nowBlock) {
    logger.warn('tron: could not read current block; skipping promotion tick');
    return;
  }

  await updateConfirmationsAndPromote(nowBlock);
  await query(
    `UPDATE chain_cursor SET last_scanned_block = $1 WHERE network = 'TRC20'`,
    [nowBlock],
  );
  logger.debug({ nowBlock }, 'TRC20 promotion tick complete');
}

async function main(): Promise<void> {
  if (!config.tron.enabled) {
    logger.warn('TRON_ENABLED=false — TRC20 listener idle (no polling). Set it to enable Tron.');
    // Stay alive so a process supervisor doesn't flap on a crash-restart loop.
    setInterval(() => undefined, 1 << 30);
    return;
  }

  logger.info('starting TRC20 (Tron) listener');

  process.on('unhandledRejection', (reason) =>
    logger.error({ reason }, 'unhandledRejection (tron listener continues)'),
  );
  process.on('uncaughtException', (err) =>
    logger.error({ err }, 'uncaughtException (tron listener continues)'),
  );

  await refreshDepositAddresses();
  setInterval(() => {
    refreshDepositAddresses().catch((err) =>
      logger.error({ err }, 'TRC20 address refresh failed'),
    );
  }, ADDRESS_REFRESH_MS);

  let scanning = false;
  setInterval(() => {
    if (scanning) return;
    scanning = true;
    scanAddresses()
      .catch((err) => logger.error({ err }, 'TRC20 address scan failed'))
      .finally(() => {
        scanning = false;
      });
  }, POLL_INTERVAL_MS);

  // Promotion is its OWN tick with its OWN guard. It used to be the tail of the
  // scan pass, which meant a scan that overran also delayed every confirmation
  // update, every payment.confirmed webhook and every sweep enqueue behind it.
  // Nothing in promotion depends on the current scan having finished — it reads
  // rows earlier scans already committed — so decoupling them costs nothing and
  // keeps settlement moving at a fixed cadence no matter how large the watch set
  // grows.
  let promoting = false;
  setInterval(() => {
    if (promoting) return;
    promoting = true;
    promoteOnce()
      .catch((err) => logger.error({ err }, 'TRC20 promotion tick failed'))
      .finally(() => {
        promoting = false;
      });
  }, POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down TRC20 listener');
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
