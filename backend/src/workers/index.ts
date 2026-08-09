/**
 * Worker process (standalone: `node dist/workers/index.js`).
 *
 * BullMQ Workers for the queues declared in queues.ts:
 *   webhook      — deliver signed webhooks with retry (webhookService.dispatch)
 *   sweep        — move confirmed deposit funds deposit->central (gas-fund if needed)
 *   payout       — broadcast USDT payout (payoutService.executePayout)
 *   expiry       — repeatable: mark stale `waiting` payments as `expired`
 *   settle       — repeatable safety net; also reconciles paid invoices
 *   subscription — repeatable: mint the next invoice for due subscriptions
 *
 * On a successful sweep, if AUTO_PAYOUT_ENABLED, we enqueue an auto payout of the
 * confirmed amount for that payment.
 */
import { Worker, Job } from 'bullmq';
import { bullConnectionOptions } from '../db/redis';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { query, queryOne } from '../db/pool';
import {
  QUEUE_NAMES,
  scheduleExpiryJob,
  scheduleSettleJob,
  scheduleSubscriptionJob,
  sweepQueue,
  SweepJob,
  PayoutJob,
  AdminWithdrawJob,
} from './queues';
import { dispatch, enqueueWebhook } from '../services/webhookService';
import { executePayout, requestPayout } from '../services/payoutService';
import { executeAdminWithdrawal } from '../services/adminCommissionService';
import { adapterFor, parseNetwork } from '../blockchain/networks';
import { reconcilePaidInvoices } from '../services/invoiceService';
import { runDueSubscriptions } from '../services/subscriptionService';

const connection = bullConnectionOptions;

// ---------------------------------------------------------------------------
// SWEEP: move a confirmed deposit's USDT balance to the central wallet.
// Chain-specific mechanics (fee funding, signing, decimals) live in the network
// adapter (blockchain/{bsc,tron}Adapter.ts); this worker is chain-agnostic.
// ---------------------------------------------------------------------------
async function processSweep(job: Job<SweepJob>): Promise<void> {
  const { paymentId } = job.data;

  const payment = await queryOne<{
    id: string;
    client_id: string;
    deposit_address: string;
    amount_received: string;
    status: string;
    wallet_id: string;
    network: string;
    asset: string;
  }>(
    `SELECT p.id, p.client_id, p.deposit_address, p.amount_received, p.status,
            p.wallet_id, p.network, p.asset
       FROM payments p
      WHERE p.id = $1`,
    [paymentId],
  );
  if (!payment) {
    logger.warn({ paymentId }, 'sweep: payment not found');
    return;
  }
  if (payment.status !== 'confirmed') {
    logger.info({ paymentId, status: payment.status }, 'sweep: payment not confirmed; skip');
    return;
  }

  // Resolve the HD derivation index for this deposit wallet.
  const wallet = await queryOne<{ derivation_index: string }>(
    `SELECT derivation_index FROM wallets WHERE id = $1 AND type = 'deposit'`,
    [payment.wallet_id],
  );
  if (!wallet || wallet.derivation_index === null) {
    logger.error({ paymentId }, 'sweep: deposit wallet / derivation_index missing');
    return;
  }
  const index = Number(wallet.derivation_index);

  // Dispatch to the payment's chain AND its asset. sweepDeposit funds fees if
  // needed, moves the full balance OF THAT ASSET to the chain's central wallet,
  // and returns null on dust. Passing the asset is load-bearing: without it the
  // adapter defaults to USDT and would move the wrong token — or nothing.
  const adapter = adapterFor(parseNetwork(payment.network));
  const result = await adapter.sweepDeposit({
    paymentId,
    depositAddress: payment.deposit_address,
    derivationIndex: index,
    asset: payment.asset,
  });
  if (!result) {
    // Below the network's minimum sweep amount — nothing to do (not an error).
    return;
  }
  const { txHash, amount: balanceHuman } = result;
  const sweptAsset = result.asset ?? payment.asset ?? 'USDT';

  await query(
    `INSERT INTO blockchain_transactions
       (payment_id, direction, tx_hash, from_address, to_address, amount, token,
        asset, network, status)
     VALUES ($1, 'sweep', $2, $3, $4, $5, $6, $6, $7, 'confirmed')
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      paymentId,
      txHash,
      payment.deposit_address,
      adapter.centralWalletAddress,
      balanceHuman,
      sweptAsset,
      payment.network,
    ],
  );

  // Mark payment swept.
  await query(
    `UPDATE payments SET status = 'swept' WHERE id = $1 AND status = 'confirmed'`,
    [paymentId],
  );
  logger.info(
    { paymentId, txHash, amount: balanceHuman, network: payment.network },
    'deposit swept to central',
  );

  enqueueWebhook({
    paymentId,
    event: 'payment.swept',
    overrides: { status: 'swept', txHash, amount: balanceHuman },
  }).catch((err) => logger.warn({ err, paymentId }, 'swept webhook enqueue failed'));

  // ---- Auto payout on confirmation (after sweep) ----
  // requestPayout resolves the per-network payout wallet itself and throws a
  // friendly error when it is unset — so a merchant who only configured a BEP20
  // wallet simply doesn't get auto TRC20 payouts (logged as a skip, not a fault).
  if (config.settlement.autoPayoutEnabled) {
    try {
      await requestPayout({
        clientId: payment.client_id,
        amount: balanceHuman,
        paymentId,
        network: payment.network,
        // Settle in the asset that actually arrived. Never cross assets here —
        // converting requires an explicit merchant preference and a swap, which
        // is a separate, opt-in path.
        asset: sweptAsset,
        type: 'auto',
        triggeredByUserId: null,
      });
      logger.info({ paymentId }, 'auto payout enqueued after sweep');
    } catch (err) {
      // e.g. zero net after commission, or amount exceeds available balance —
      // expected in some configs, so this is a skip, not a hard error.
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ paymentId, reason }, 'auto payout skipped');
    }
  }
}

// ---------------------------------------------------------------------------
// EXPIRY: mark waiting payments past expires_at as expired (idempotent).
// ---------------------------------------------------------------------------
async function processExpiry(): Promise<void> {
  const rows = await query<{ id: string }>(
    `UPDATE payments
        SET status = 'expired'
      WHERE status = 'waiting'
        AND expires_at < now()
      RETURNING id`,
  );
  if (rows.length > 0) {
    logger.info({ count: rows.length }, 'expired stale waiting payments');
    for (const r of rows) {
      enqueueWebhook({
        paymentId: r.id,
        event: 'payment.expired',
        overrides: { status: 'expired' },
      }).catch((err) => logger.warn({ err, paymentId: r.id }, 'expired webhook enqueue failed'));
    }
  }
}

// ---------------------------------------------------------------------------
// SETTLE (safety net): re-drive settlement for payments that confirmed but never
// got swept/paid out (worker was down, transient RPC failure, etc). Idempotent.
// ---------------------------------------------------------------------------
/**
 * How many stalled payments the settle tick re-drives per pass. The tick runs
 * every minute, so this is 500/min of catch-up capacity — far above any real
 * arrival rate, while keeping one pass bounded.
 */
const SETTLE_BATCH_LIMIT = 500;

async function processSettle(): Promise<void> {
  // 1) Confirmed-but-unswept -> (re)enqueue sweep. jobId dedupes in-flight sweeps.
  //
  // Bounded. This runs every minute and previously selected EVERY confirmed
  // payment: if sweeps stall (RPC outage, an empty gas wallet), the backlog
  // grows and each tick re-enqueues all of it. Oldest first, so a backlog drains
  // in order instead of the same head being retried forever.
  const confirmed = await query<{ id: string }>(
    `SELECT id FROM payments
      WHERE status = 'confirmed'
      ORDER BY confirmed_at ASC NULLS FIRST
      LIMIT $1`,
    [SETTLE_BATCH_LIMIT],
  );
  for (const p of confirmed) {
    await sweepQueue.add('sweep', { paymentId: p.id } as SweepJob, {
      jobId: `sweep-${p.id}`,
    });
  }

  // 2) Swept + payout wallet set + no active payout -> (re)enqueue auto payout.
  // The wallet-set guard is per-network: a payment settles on ITS network, using
  // payout_wallet (BEP20), payout_wallet_trc20 (TRC20) or payout_wallet_erc20
  // (Ethereum). This avoids re-enqueuing a payout for a merchant who only
  // configured one chain's wallet — it would just throw, every minute, forever.
  if (config.settlement.autoPayoutEnabled) {
    const swept = await query<{
      id: string;
      client_id: string;
      amount_received: string;
      network: string;
    }>(
      `SELECT p.id, p.client_id, p.amount_received, p.network
         FROM payments p
         JOIN clients c ON c.id = p.client_id
        WHERE p.status = 'swept'
          AND (
            (p.network = 'BEP20' AND c.payout_wallet IS NOT NULL) OR
            (p.network = 'TRC20' AND c.payout_wallet_trc20 IS NOT NULL) OR
            (p.network = 'ERC20' AND c.payout_wallet_erc20 IS NOT NULL) OR
            (p.network = 'BTC'   AND c.payout_wallet_btc   IS NOT NULL)
          )
          AND NOT EXISTS (
            SELECT 1 FROM payouts po
             WHERE po.payment_id = p.id
               AND po.status IN ('pending','processing','sent','confirmed')
          )`,
    );
    for (const p of swept) {
      try {
        await requestPayout({
          clientId: p.client_id,
          amount: p.amount_received,
          paymentId: p.id,
          network: p.network,
          type: 'auto',
          triggeredByUserId: null,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn({ paymentId: p.id, reason }, 'settle: auto payout skipped');
      }
    }
  }

  if (confirmed.length > 0) {
    logger.info(
      { count: confirmed.length, capped: confirmed.length === SETTLE_BATCH_LIMIT },
      'settle: re-enqueued sweeps for confirmed payments',
    );
  }

  // 3) Invoices whose payment has settled -> mark paid.
  //
  // Deliberately here rather than fired from the listener at the moment of
  // confirmation: a status change that rides on a single in-process event is
  // lost the one time that process is restarting. This is a sweep over reality
  // and is correct whether or not any particular event was delivered.
  // Idempotent — it only ever matches invoices still 'open'.
  try {
    await reconcilePaidInvoices();
  } catch (err) {
    // Never let this fail the settle tick: sweeps and payouts are the money
    // path, and marking an invoice paid is bookkeeping that can wait a minute.
    logger.error({ err }, 'settle: invoice reconciliation failed');
  }
}

// ---------------------------------------------------------------------------
// SUBSCRIPTION: mint invoices for plans whose next cycle is due.
// All the interesting logic (double-bill guard, drift-free scheduling, backlog
// parking) lives in services/subscriptionService.ts.
// ---------------------------------------------------------------------------
async function processSubscriptions(): Promise<void> {
  await runDueSubscriptions();
}

// ---------------------------------------------------------------------------
// Worker wiring
// ---------------------------------------------------------------------------
function startWorkers(): Worker[] {
  const webhookWorker = new Worker(
    QUEUE_NAMES.webhook,
    async (job) => dispatch(job as Job<{ webhookLogId: string }>),
    { connection, concurrency: 10 },
  );

  const sweepWorker = new Worker(
    QUEUE_NAMES.sweep,
    async (job) => processSweep(job as Job<SweepJob>),
    { connection, concurrency: 3 },
  );

  const payoutWorker = new Worker(
    QUEUE_NAMES.payout,
    async (job) => executePayout(job as Job<PayoutJob>),
    { connection, concurrency: 3 },
  );

  const expiryWorker = new Worker(QUEUE_NAMES.expiry, async () => processExpiry(), {
    connection,
    concurrency: 1,
  });

  const settleWorker = new Worker(QUEUE_NAMES.settle, async () => processSettle(), {
    connection,
    concurrency: 1,
  });

  // Concurrency 1: one tick at a time is plenty for a per-minute schedule, and
  // it keeps the common case free of the row contention the per-subscription
  // locks exist to handle. Correctness does not depend on it — the unique
  // (subscription, cycle) index holds regardless of how many run at once.
  const subscriptionWorker = new Worker(
    QUEUE_NAMES.subscription,
    async () => processSubscriptions(),
    { connection, concurrency: 1 },
  );

  const adminWithdrawWorker = new Worker(
    QUEUE_NAMES.adminWithdraw,
    async (job) => executeAdminWithdrawal(job as Job<AdminWithdrawJob>),
    { connection, concurrency: 2 },
  );

  const workers = [
    webhookWorker,
    sweepWorker,
    payoutWorker,
    expiryWorker,
    settleWorker,
    subscriptionWorker,
    adminWithdrawWorker,
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => {
      logger.error(
        { queue: w.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err },
        'job failed',
      );
    });
    w.on('completed', (job) => {
      logger.debug({ queue: w.name, jobId: job.id }, 'job completed');
    });
  }
  return workers;
}

async function main(): Promise<void> {
  logger.info('starting workers');
  await scheduleExpiryJob();
  await scheduleSettleJob();
  await scheduleSubscriptionJob();
  const workers = startWorkers();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down workers');
    await Promise.allSettled(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
