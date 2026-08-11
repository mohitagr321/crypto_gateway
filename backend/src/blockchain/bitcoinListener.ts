/**
 * Bitcoin listener (standalone: `node dist/blockchain/bitcoinListener.js`).
 *
 * ADDRESS-DRIVEN, like the Tron listener and for the same reason: Esplora
 * indexes by address, and there is no practical "give me every payment to this
 * set of addresses in block range X..Y" query. So each pass asks, per watched
 * address, what transactions touch it.
 *
 *   1. Refresh the set of active BTC deposit addresses from Postgres.
 *   2. For each, GET /address/{addr}/txs and credit any output paying it.
 *   3. Update confirmations from the tip and promote at the threshold, driving
 *      the payment state machine identically to every other chain.
 *
 * ============================ TWO TICKS, NOT ONE =============================
 * Esplora has no multi-address endpoint, so step 2 is irreducibly one HTTP
 * request per watched address. What IS reducible is doing them one after
 * another: a sequential pass grew linearly with the number of open payments
 * until it outran the payment expiry window, at which point an address was
 * expired and dropped from the watch set before it had ever been polled — with a
 * real deposit sitting on it. The scan now runs a bounded window of addresses in
 * parallel against a per-pass deadline, least-recently-scanned first, so no
 * address can be starved and no single slow address can stall the pass.
 *
 * Step 3 is pure SQL over rows step 2 already wrote, and used to be the last
 * statement of the same pass — so a slow scan delayed every confirmation update,
 * every payment.confirmed webhook and every sweep enqueue by exactly as much.
 * It is now an independent interval with its own guard.
 *
 * ============================ NO REORG DANCE =================================
 * Unlike the BSC listener there is no reorg-revert path here, and that is a
 * considered choice rather than an omission. A Bitcoin reorg deeper than one or
 * two blocks is vanishingly rare, and `BTC_REQUIRED_CONFIRMATIONS` (default 2,
 * ~20 minutes) is the protection: a payment is not promoted until it is buried.
 * Recording an unconfirmed transaction and then unwinding it would add a whole
 * failure mode to guard against something the confirmation count already covers.
 *
 * Consequently only CONFIRMED transactions are recorded at all — a mempool
 * transaction is visible in the API but is not yet money.
 *
 * IDEMPOTENCY: identical to the other listeners. UNIQUE (tx_hash, log_index)
 * makes the insert a no-op on replay, and every status transition carries a
 * WHERE guard.
 *
 * This process is a NO-OP unless BTC_ENABLED=true; it logs and idles otherwise,
 * so it is always safe to add to the process supervisor.
 */
import { config } from '../config/env';
import { logger } from '../config/logger';
import { pool, query, queryOne } from '../db/pool';
import { sweepQueue, SweepJob } from '../workers/queues';
import { enqueueWebhook } from '../services/webhookService';
import { addressTxs, satsToBtc, tipHeight } from './bitcoin';
import { assetFor } from './assets';
import { recordUnexpectedDeposit } from '../services/unexpectedDepositService';

/**
 * SQL for a payment's received total: the sum of its non-reorged incoming
 * transfers. Recomputed rather than assigned — see the same note in listener.ts.
 */
const RECEIVED_SUM = `COALESCE((
              SELECT SUM(bt.amount)
                FROM blockchain_transactions bt
               WHERE bt.payment_id = payments.id
                 AND bt.direction = 'incoming'
                 AND bt.status <> 'reorged'
            ), 0)`;

/**
 * Bitcoin blocks are ~10 minutes, so polling faster than this only burns API
 * quota. 30s still means a confirmation is noticed well inside one block.
 */
const POLL_INTERVAL_MS = 30_000;
const ADDRESS_REFRESH_MS = 30_000;

/**
 * How many addresses are scanned concurrently.
 *
 * A small window, not a Promise.all over the whole watch set: the public Esplora
 * instances (blockstream.info, mempool.space) rate-limit, and being throttled off
 * the only API this listener has is a worse failure than being slow. Each
 * request already carries its own 15s deadline inside bitcoin.ts, so the window
 * bounds concurrency, not patience.
 */
const SCAN_CONCURRENCY = 6;

/**
 * How long one address-scan pass may run before it stops and hands over to the
 * next tick. The next pass resumes with whatever this one did not reach — see
 * the least-recently-scanned ordering in scanAddresses().
 */
const PASS_DEADLINE_MS = POLL_INTERVAL_MS * 6;

/** Watched deposit addresses. */
const depositAddresses = new Set<string>();

/**
 * Address -> epoch ms of its last completed scan. Only used to order the next
 * pass; pruned to the watch set each pass, so it cannot outgrow it.
 */
const lastScannedAt = new Map<string, number>();

async function refreshDepositAddresses(): Promise<void> {
  const rows = await query<{ address: string }>(
    `SELECT DISTINCT deposit_address AS address
       FROM payments
      WHERE status IN ('waiting', 'confirming', 'partial')
        AND network = 'BTC'`,
  );
  depositAddresses.clear();
  for (const r of rows) depositAddresses.add(r.address);
  logger.info({ count: depositAddresses.size }, 'refreshed BTC deposit address watch set');
}

/**
 * Record one confirmed output paying a deposit address.
 *
 * `log_index` carries the OUTPUT INDEX (vout). That is the natural analogue of a
 * log index and, like it, is non-negative and unique within the transaction — so
 * one transaction paying the same address twice records two rows rather than
 * silently collapsing into one under UNIQUE (tx_hash, log_index).
 */
async function recordIncoming(params: {
  txid: string;
  vout: number;
  address: string;
  valueSats: bigint;
  blockHeight: number;
}): Promise<void> {
  const { txid, vout, address, valueSats, blockHeight } = params;

  const payment = await queryOne<{ id: string; status: string }>(
    `SELECT id, status
       FROM payments
      WHERE deposit_address = $1
        AND status IN ('waiting', 'confirming', 'partial')
        AND network = 'BTC'
        AND asset = 'BTC'
      ORDER BY created_at ASC
      LIMIT 1`,
    [address],
  );
  const amountHuman = satsToBtc(valueSats);

  if (!payment) {
    // There is no WRONG-ASSET case on Bitcoin — one chain, one asset. What there
    // is, and what this used to drop on the floor with a bare `return`, is the
    // LATE PAYMENT case: coins landing on OUR deposit address after its payment
    // stopped being creditable (expired between the customer broadcasting and
    // this listener seeing it, or already confirmed/swept). EVM and Tron have
    // filed that as an unexpected_deposits row since the service existed; BTC
    // alone left no row, no warn and nothing an operator or the merchant could
    // act on, while the funds sat at an address only the HD index can reach.
    //
    // THE EXISTENCE CHECK IS LOAD-BEARING. Esplora returns an address's FULL
    // history on every pass, and the watch-set snapshot is up to
    // ADDRESS_REFRESH_MS stale — so an ordinary deposit that was credited and
    // then promoted out of ('waiting','confirming','partial') is re-read here on
    // the very next scan. Without this, every healthy BTC payment would file
    // itself as unrecovered money the moment it confirmed, and the operator
    // recovery flow would try to sweep an address the sweep worker owns.
    // (tx_hash, log_index) is UNIQUE on blockchain_transactions, so the lookup
    // is an index probe.
    const alreadyCredited = await queryOne<{ id: string }>(
      `SELECT id FROM blockchain_transactions
        WHERE tx_hash = $1 AND log_index = $2 AND direction = 'incoming'
        LIMIT 1`,
      [txid, vout],
    );
    if (alreadyCredited) return;

    try {
      await recordUnexpectedDeposit({
        network: 'BTC',
        asset: assetFor('BTC', 'BTC'),
        amountHuman,
        depositAddress: address,
        txHash: txid,
        // The output index, exactly as the credited path uses it — so one
        // transaction paying the address twice files two rows rather than one,
        // and a row here can never collide with a different output.
        logIndex: vout,
      });
    } catch (err) {
      // recordUnexpectedDeposit swallows its own failures; this catches the
      // asset lookup. A listener must never die over a bookkeeping row.
      logger.error(
        { err, txHash: txid, vout, address },
        'btc: could not record an unmatched deposit; funds remain recoverable by HD index',
      );
    }
    return;
  }

  await query(
    `INSERT INTO blockchain_transactions
       (payment_id, direction, tx_hash, from_address, to_address, amount, token,
        network, block_number, confirmations, status, log_index, asset)
     VALUES ($1, 'incoming', $2, $3, $4, $5, 'BTC', 'BTC', $6, 0, 'pending', $7, 'BTC')
     ON CONFLICT (tx_hash, log_index)
     DO UPDATE SET block_number = EXCLUDED.block_number`,
    [
      payment.id,
      txid,
      // Bitcoin has no single "from": a transaction spends many inputs, often
      // from several owners. Recording the destination is honest; inventing a
      // sender would not be.
      '(utxo inputs)',
      address,
      amountHuman,
      blockHeight,
      vout,
    ],
  );

  await query(
    `UPDATE payments
        SET amount_received = ${RECEIVED_SUM},
            tx_hash = $2,
            status = CASE WHEN status = 'waiting' THEN 'confirming' ELSE status END
      WHERE id = $1
        AND status IN ('waiting', 'confirming', 'partial')`,
    [payment.id, txid],
  );

  logger.info(
    { paymentId: payment.id, txHash: txid, vout, amount: amountHuman },
    'incoming BTC recorded (confirming)',
  );

  if (payment.status === 'waiting') {
    enqueueWebhook({ paymentId: payment.id, event: 'payment.confirming' }).catch((err) =>
      logger.warn({ err, paymentId: payment.id }, 'confirming webhook enqueue failed'),
    );
  }
}

/**
 * Update confirmations from the tip and promote payments past the threshold.
 * Mirrors the other listeners; every guard fires exactly once.
 *
 * Confirmations are INCLUSIVE of the containing block: a transaction in the tip
 * block has one confirmation, not zero.
 */
async function updateConfirmationsAndPromote(tip: number): Promise<void> {
  await query(
    `UPDATE blockchain_transactions
        SET confirmations = GREATEST(0, $1 - block_number + 1)
      WHERE direction = 'incoming'
        AND status = 'pending'
        AND network = 'BTC'
        AND block_number IS NOT NULL`,
    [tip],
  );

  await query(
    `UPDATE payments p
        SET confirmations = GREATEST(0, $1 - bt.block_number + 1)
       FROM blockchain_transactions bt
      WHERE bt.payment_id = p.id
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = 'BTC'
        AND p.status IN ('confirming', 'partial')`,
    [tip],
  );

  // `fully_paid`: confirmation DEPTH and payment SUFFICIENCY are independent
  // questions, and this only ever asked the first — see the note in
  // evmListener.ts. On Bitcoin the stakes are the same: any nonzero output to
  // the deposit address that got deep enough confirmed the whole invoice.
  //
  // `partial` IS SELECTED HERE, not `confirming` alone, for the same reason it
  // is on the other two chains: recordIncoming accepts `partial` and files a
  // top-up as a fresh `pending` row, so the money arrives and amount_received
  // grows past `amount` — but matching `confirming` alone meant nothing could
  // ever select the payment again. Never promoted, never swept, never expired
  // (processExpiry only touches `waiting`), sitting on the merchant's pending
  // balance forever with the coins at the deposit address and nothing anywhere
  // that could move them. A settled `partial` costs nothing to re-check: the
  // branch below marks its incoming rows `confirmed`, so a payment with no NEW
  // money has no `pending` row left to join against.
  const ready = await query<{ id: string; fully_paid: boolean }>(
    `SELECT p.id, (p.amount_received >= p.amount) AS fully_paid
       FROM payments p
       JOIN blockchain_transactions bt ON bt.payment_id = p.id
      WHERE p.status IN ('confirming', 'partial')
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = 'BTC'
        AND ($1 - bt.block_number + 1) >= p.required_confirmations`,
    [tip],
  );

  for (const p of ready) {
    // UNDERPAID: hold as `partial`. No payment.confirmed, no sweep. The payment
    // stays open for a top-up and is never expired out from under the funds.
    if (!p.fully_paid) {
      // `amount_received < amount` is re-tested HERE, inside the write, and not
      // merely trusted from the SELECT above. Promotion used to be the tail of
      // the address scan, so nothing could record an output between the two; now
      // that the two are separate ticks, a top-up landing in that window would be
      // read as underpaid and the (by then fully paid) invoice would be frozen as
      // `partial` — never confirmed, never swept. Losing this race is harmless:
      // zero rows means the payment is already covered, its transaction rows are
      // still `pending`, and the next tick promotes it properly.
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
            AND network = 'BTC'`,
        [p.id],
      );

      logger.warn(
        { paymentId: p.id, expected: marked[0].amount, received: marked[0].amount_received },
        'BTC payment underpaid — held as partial, not confirmed, not swept',
      );
      continue;
    }

    // Promote confirming/partial -> confirmed, guarded so it fires exactly once.
    // `partial` is included because that is the topped-up case: the shortfall is
    // covered, so the hold is released and the payment settles down the ordinary
    // path — webhook, sweep, payout.
    const promoted = await query<{ id: string }>(
      `UPDATE payments SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1 AND status IN ('confirming', 'partial') RETURNING id`,
      [p.id],
    );
    if (promoted.length === 0) continue;

    await query(
      `UPDATE blockchain_transactions SET status = 'confirmed'
        WHERE payment_id = $1 AND direction = 'incoming' AND status = 'pending'
          AND network = 'BTC'`,
      [p.id],
    );

    logger.info({ paymentId: p.id }, 'BTC payment confirmed');

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
 * Everything one watched address costs: a single /address/{addr}/txs call and
 * the credit of any confirmed output paying it.
 *
 * Never throws. An address that times out or 429s is logged and abandoned for
 * this pass only; it still counts as scanned for the ordering, so it rotates to
 * the back and is retried after the rest of the watch set. Deliberate: a
 * permanently failing address must not be allowed to sit at the head of every
 * pass and consume the deadline that healthy addresses need.
 */
async function scanAddress(address: string): Promise<void> {
  let txs;
  try {
    txs = await addressTxs(address);
  } catch (err) {
    logger.warn({ err, address }, 'btc: address lookup failed; will retry');
    return;
  }

  for (const tx of txs) {
    // Only confirmed transactions are money — see the header note on reorgs.
    if (!tx.status?.confirmed || !tx.status.block_height) continue;
    for (let vout = 0; vout < tx.vout.length; vout++) {
      const out = tx.vout[vout];
      if (out.scriptpubkey_address !== address) continue;
      if (!out.value || out.value <= 0) continue;
      await recordIncoming({
        txid: tx.txid,
        vout,
        address,
        valueSats: BigInt(out.value),
        blockHeight: tx.status.block_height,
      });
    }
  }
}

/**
 * Run `work` over `items`, at most `limit` at a time, stopping once `deadline`
 * has passed. Returns how many items were taken.
 *
 * A worker never propagates a failure: the point of the pool is that no single
 * address can abort the scan, and a rejected worker would abort the Promise.all
 * and leave the rest of the watch set unscanned.
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
        logger.warn({ err }, 'btc: address scan failed; will retry next pass');
      }
    }
  });
  await Promise.all(workers);
  return cursor;
}

/** One address-scan pass over the watch set. See the header note. */
async function scanAddresses(): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + PASS_DEADLINE_MS;

  // Snapshot BEFORE any I/O. refreshDepositAddresses runs on its own 30s timer
  // and does clear() + add(), and a Set being iterated across an await does not
  // survive that cleanly — the iterator skips the emptied entries and walks into
  // the newly appended ones instead. Any pass longer than the refresh interval
  // was therefore scanning a garbled subset and could be extended without bound.
  const snapshot = Array.from(depositAddresses);

  // Forget addresses that have left the watch set, then scan least-recently-
  // scanned first: a pass that cannot cover everything before its deadline must
  // not restart at the head each time, or the tail — where the oldest payments,
  // the ones closest to expiry, live — would never be polled at all.
  for (const address of lastScannedAt.keys()) {
    if (!depositAddresses.has(address)) lastScannedAt.delete(address);
  }
  snapshot.sort((a, b) => (lastScannedAt.get(a) ?? 0) - (lastScannedAt.get(b) ?? 0));

  const scanned = await runPool(snapshot, SCAN_CONCURRENCY, deadline, async (address) => {
    await scanAddress(address);
    lastScannedAt.set(address, Date.now());
  });

  const passMs = Date.now() - startedAt;
  // The ratio that predicts stranded deposits: once a full sweep of the watch
  // set approaches the payment expiry window, deposits start expiring before
  // they are ever polled. A quarter of the window is the alarm, not the limit.
  const budgetMs = (config.paymentExpiryMinutes * 60_000) / 4;
  const sweepMs = scanned > 0 ? (passMs * snapshot.length) / scanned : passMs;
  if (scanned < snapshot.length || sweepMs > budgetMs) {
    logger.error(
      { passMs, sweepMs: Math.round(sweepMs), scanned, watching: snapshot.length, budgetMs },
      'BTC address scan is falling behind — deposits may be detected late',
    );
  } else {
    logger.debug({ passMs, watching: snapshot.length }, 'BTC address scan complete');
  }
}

/**
 * Confirmation + promotion tick. Reads the tip itself rather than being handed
 * one by the address scan, because it no longer runs inside it.
 */
async function promoteOnce(): Promise<void> {
  const tip = await tipHeight();
  if (!tip) {
    logger.warn('btc: could not read the chain tip; skipping promotion tick');
    return;
  }

  await updateConfirmationsAndPromote(tip);
  await query(`UPDATE chain_cursor SET last_scanned_block = $1 WHERE network = 'BTC'`, [
    tip,
  ]);
  logger.debug({ tip }, 'BTC promotion tick complete');
}

async function main(): Promise<void> {
  if (!config.btc.enabled) {
    logger.warn('BTC_ENABLED=false — Bitcoin listener idle (no polling). Set it to enable BTC.');
    setInterval(() => undefined, 1 << 30);
    return;
  }

  logger.info(
    { network: config.btc.isTestnet ? 'testnet' : 'mainnet', api: config.btc.apiUrl },
    'starting Bitcoin listener',
  );

  process.on('unhandledRejection', (reason) =>
    logger.error({ reason }, 'unhandledRejection (btc listener continues)'),
  );
  process.on('uncaughtException', (err) =>
    logger.error({ err }, 'uncaughtException (btc listener continues)'),
  );

  await refreshDepositAddresses();
  setInterval(() => {
    refreshDepositAddresses().catch((err) =>
      logger.error({ err }, 'BTC address refresh failed'),
    );
  }, ADDRESS_REFRESH_MS);

  let scanning = false;
  setInterval(() => {
    if (scanning) return;
    scanning = true;
    scanAddresses()
      .catch((err) => logger.error({ err }, 'BTC address scan failed'))
      .finally(() => {
        scanning = false;
      });
  }, POLL_INTERVAL_MS);

  // Promotion is its OWN tick with its OWN guard. It used to be the tail of the
  // scan pass, so a scan that overran also held back every confirmation update,
  // every payment.confirmed webhook and every sweep enqueue behind it. Nothing
  // in promotion depends on the current scan having finished — it reads rows
  // earlier scans already committed — so settlement now advances at a fixed
  // cadence however large the watch set grows.
  let promoting = false;
  setInterval(() => {
    if (promoting) return;
    promoting = true;
    promoteOnce()
      .catch((err) => logger.error({ err }, 'BTC promotion tick failed'))
      .finally(() => {
        promoting = false;
      });
  }, POLL_INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down BTC listener');
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
