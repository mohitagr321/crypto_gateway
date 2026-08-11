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

/** Watched deposit addresses. */
const depositAddresses = new Set<string>();

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
  // No wrong-asset case to handle: Bitcoin has exactly one asset, so an
  // unmatched payment here means the address is simply not ours (or its payment
  // already settled). Nothing to record.
  if (!payment) return;

  const amountHuman = satsToBtc(valueSats);

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
        AND p.status = 'confirming'`,
    [tip],
  );

  // `fully_paid`: confirmation DEPTH and payment SUFFICIENCY are independent
  // questions, and this only ever asked the first — see the note in
  // evmListener.ts. On Bitcoin the stakes are the same: any nonzero output to
  // the deposit address that got deep enough confirmed the whole invoice.
  const ready = await query<{ id: string; fully_paid: boolean }>(
    `SELECT p.id, (p.amount_received >= p.amount) AS fully_paid
       FROM payments p
       JOIN blockchain_transactions bt ON bt.payment_id = p.id
      WHERE p.status = 'confirming'
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
            AND network = 'BTC'`,
        [p.id],
      );

      logger.warn(
        { paymentId: p.id, expected: marked[0].amount, received: marked[0].amount_received },
        'BTC payment underpaid — held as partial, not confirmed, not swept',
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

async function pollOnce(): Promise<void> {
  const tip = await tipHeight();
  if (!tip) {
    logger.warn('btc: could not read the chain tip; skipping pass');
    return;
  }

  for (const address of depositAddresses) {
    let txs;
    try {
      txs = await addressTxs(address);
    } catch (err) {
      // Skip only THIS address; the rest of the pass still runs.
      logger.warn({ err, address }, 'btc: address lookup failed; will retry');
      continue;
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

  await updateConfirmationsAndPromote(tip);
  await query(`UPDATE chain_cursor SET last_scanned_block = $1 WHERE network = 'BTC'`, [
    tip,
  ]);
  logger.debug({ tip, watching: depositAddresses.size }, 'BTC poll complete');
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

  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    pollOnce()
      .catch((err) => logger.error({ err }, 'BTC poll pass failed'))
      .finally(() => {
        running = false;
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
