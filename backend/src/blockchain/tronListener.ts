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

  const res = await fetch(url, {
    headers: config.tron.apiKey ? { 'TRON-PRO-API-KEY': config.tron.apiKey } : {},
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${res.status} ${res.statusText} for ${address}`);
  }
  const body = (await res.json()) as { data?: TrongridTrc20Tx[]; success?: boolean };
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

  const res = await fetch(url, {
    headers: config.tron.apiKey ? { 'TRON-PRO-API-KEY': config.tron.apiKey } : {},
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${res.status} ${res.statusText} for ${address} (native)`);
  }
  const body = (await res.json()) as { data?: TrongridNativeTx[] };
  const rows = Array.isArray(body.data) ? body.data : [];

  const out: NativeTransfer[] = [];
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
        out.push({
          txId: tx.txID,
          blockNumber: tx.blockNumber,
          from: tronAddressFromHex(v.owner_address ?? ''),
          to,
          amountSun: amount,
        });
      }
    }

    // ---- TRX forwarded by a contract ----
    for (const it of tx.internal_transactions ?? []) {
      if (it.rejected) continue;
      const to = tronAddressFromHex(it.transferTo_address ?? '');
      if (to !== address) continue;
      const amount = (it.callValueInfo ?? []).reduce(
        (acc, c) => acc + BigInt(Math.trunc(c.callValue ?? 0)),
        0n,
      );
      if (amount <= 0n) continue;
      out.push({
        txId: tx.txID,
        blockNumber: tx.blockNumber,
        from: tronAddressFromHex(it.caller_address ?? ''),
        to,
        amountSun: amount,
      });
    }
  }
  return out;
}

/**
 * Resolve the block number a Tron tx landed in. The list endpoint omits it, but
 * confirmations are computed against it, so we fetch the receipt once per tx.
 */
async function blockNumberOf(txHash: string): Promise<number | null> {
  try {
    const info = (await tronClient().trx.getTransactionInfo(txHash)) as {
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

  await query(
    `INSERT INTO blockchain_transactions
       (payment_id, direction, tx_hash, from_address, to_address, amount, token,
        network, block_number, confirmations, status, log_index, asset)
     VALUES ($1, 'incoming', $2, $3, $4, $5, $7, 'TRC20', $6, 0, 'pending', $8, $7)
     ON CONFLICT (tx_hash, log_index)
     DO UPDATE SET block_number = EXCLUDED.block_number`,
    [payment.id, txId, from, to, amountHuman, blockNumber, asset.symbol, logIndex],
  );

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
        AND p.status = 'confirming'`,
    [nowBlock],
  );

  // `fully_paid`: confirmation DEPTH and payment SUFFICIENCY are independent
  // questions, and this only ever asked the first — see the note in
  // evmListener.ts. Any nonzero TRC20 transfer that got deep enough confirmed
  // the whole invoice.
  const ready = await query<{ id: string; fully_paid: boolean }>(
    `SELECT p.id, (p.amount_received >= p.amount) AS fully_paid
       FROM payments p
       JOIN blockchain_transactions bt ON bt.payment_id = p.id
      WHERE p.status = 'confirming'
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
      const marked = await query<{ id: string; amount: string; amount_received: string }>(
        `UPDATE payments SET status = 'partial'
          WHERE id = $1 AND status = 'confirming'
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

    const promoted = await query<{ id: string }>(
      `UPDATE payments SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1 AND status = 'confirming' RETURNING id`,
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

async function pollOnce(): Promise<void> {
  const block = await tronClient().trx.getCurrentBlock();
  const nowBlock = Number(
    (block as { block_header?: { raw_data?: { number?: number } } })?.block_header?.raw_data
      ?.number ?? 0,
  );
  if (!nowBlock) {
    logger.warn('tron: could not read current block; skipping pass');
    return;
  }

  // TronGrid's trc20 endpoint filters by a SINGLE contract, so this is one call
  // per (address, asset). That is O(addresses x assets) requests per pass, which
  // is why the asset list should stay short on Tron — TronGrid rate-limits hard
  // without an API key.
  const trcAssets = tokenAssetsFor('TRC20');
  // Native TRX, when accepted. Undefined leaves this loop exactly as it was.
  const native = nativeAssetFor('TRC20');

  for (const [address, sinceMs] of depositAddresses) {
    // ---- Native TRX: one call per address, not per (address, asset) ----
    // The plain transaction feed is not filtered by contract, so a single
    // request covers it — and it carries blockNumber inline, so unlike the
    // token path below there is no follow-up receipt lookup per transfer.
    if (native) {
      try {
        for (const t of await fetchInboundNative(address, sinceMs)) {
          await recordIncomingNative(t, native);
        }
      } catch (err) {
        logger.warn(
          { err, address },
          'tron: fetch inbound native transfers failed; will retry',
        );
      }
    }

    for (const asset of trcAssets) {
      let transfers: TrongridTrc20Tx[];
      try {
        transfers = await fetchInboundTransfers(address, sinceMs, asset);
      } catch (err) {
        // Skip only THIS asset for this address; the others still get scanned.
        logger.warn(
          { err, address, asset: asset.symbol },
          'tron: fetch inbound transfers failed; will retry',
        );
        continue;
      }
      for (const t of transfers) {
        if (t.type !== 'Transfer') continue;
        if (t.to !== address) continue; // defensive
        const blockNumber = await blockNumberOf(t.transaction_id);
        if (blockNumber === null) continue; // not solidified yet, or reverted
        await recordIncoming(t, blockNumber, asset);
      }
    }
  }

  await updateConfirmationsAndPromote(nowBlock);
  await query(
    `UPDATE chain_cursor SET last_scanned_block = $1 WHERE network = 'TRC20'`,
    [nowBlock],
  );
  logger.debug({ nowBlock, watching: depositAddresses.size }, 'TRC20 poll complete');
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

  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    pollOnce()
      .catch((err) => logger.error({ err }, 'TRC20 poll pass failed'))
      .finally(() => {
        running = false;
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
