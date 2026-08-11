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
import { parseAsset } from '../blockchain/assets';
import { reconcilePaidInvoices } from '../services/invoiceService';
import { runDueSubscriptions } from '../services/subscriptionService';
import { recordUnexpectedDeposit } from '../services/unexpectedDepositService';
import { toAccountingUnits } from '../utils/money';

const connection = bullConnectionOptions;

// ---------------------------------------------------------------------------
// Enqueueing a sweep.
//
// `jobId: sweep-<paymentId>` looks like a lease. It is not — it is a dedupe key
// with an unbounded lifetime. BullMQ's addStandardJob script returns early the
// moment the job hash EXISTS, in whatever state, and `removeOnComplete: 1000` /
// `removeOnFail: 5000` (queues.ts) retain that hash by COUNT, not by age. So the
// first time a sweep for a payment ended in a terminal state — the gas station
// was dry and the job exhausted its 5 attempts, or the Ethereum fee ceiling made
// sweepDeposit return null and the job COMPLETED as a no-op — every subsequent
// `sweepQueue.add` for that payment was a silent success that queued nothing,
// for the next thousand sweeps. The payment stayed `confirmed`, the settle tick
// "re-enqueued" it every minute forever, and the funds stayed at the deposit
// address. The safety net this whole tick exists to be was a no-op.
//
// So: keep the jobId (in-flight dedupe is genuinely wanted — one sweep per
// payment at a time, and a chain transfer is not something to run twice), but
// clear the key ourselves once the job is TERMINAL. Re-entrancy is already
// covered twice over: processSweep re-reads `status = 'confirmed'` before doing
// anything, and sweepDeposit reads the live on-chain balance, so a re-run of an
// already-swept payment moves nothing.
const SWEEP_RETRY_COOLDOWN_MS = 5 * 60_000;

/**
 * Enqueue a sweep for `paymentId`, actually. Returns true when a job was
 * created — the settle tick logs that count, because "re-enqueued 40 sweeps"
 * meaning "created zero jobs" is exactly how this stayed invisible.
 */
async function enqueueSweep(paymentId: string): Promise<boolean> {
  const jobId = `sweep-${paymentId}`;
  const existing = await sweepQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    // waiting / active / delayed / prioritised — genuinely in flight, leave it.
    // 'unknown' means the hash outlived every set it belonged to: an orphan, and
    // the one shape that would otherwise block this payment forever, so it goes.
    if (state !== 'completed' && state !== 'failed' && state !== 'unknown') return false;
    // A sweep that just finished has already read the on-chain balance, and a
    // failed one has already burned its five attempts with backoff. Re-running
    // either within the cooldown costs an RPC round trip and one of only three
    // sweep worker slots — and a backlog of deposits that cannot move yet (dry
    // gas station, fee ceiling, dust) would consume all three every minute,
    // which starves the real sweeps behind them. That starvation is its own
    // outage, so the re-drive is deliberately unhurried: the funds are safe at
    // the deposit address, five minutes changes nothing.
    if (state !== 'unknown' && Date.now() - (existing.finishedOn ?? 0) < SWEEP_RETRY_COOLDOWN_MS) {
      return false;
    }
    try {
      await existing.remove();
    } catch (err) {
      // Lost the race with another worker (or the job just went active). The
      // next tick tries again; nothing is stranded by waiting a minute.
      logger.debug({ err, paymentId }, 'sweep: could not clear terminal job; retrying next tick');
      return false;
    }
  }
  await sweepQueue.add('sweep', { paymentId } as SweepJob, { jobId });
  return true;
}

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
    // Nothing to move. That has two very different causes, and treating them the
    // same is how a payment used to disappear.
    //
    // (1) WE ALREADY SWEPT IT, and the process died between the broadcast and
    //     the `status = 'swept'` write. The funds are at the central wallet, the
    //     deposit address is empty, so every retry from here reads a zero
    //     balance, returns null, and returns without touching the status. The
    //     payment sat at `confirmed` forever and auto-payout — which only ever
    //     fires for `swept` — never ran, so the merchant was never paid for
    //     money the gateway was holding. A prior `direction = 'sweep'` row is
    //     the receipt: adopt it and finish the transition the crash interrupted.
    // (2) Genuinely nothing there yet, or below the asset's minimum sweep
    //     amount (the fee would exceed the funds), or an adapter deferral such
    //     as the Ethereum fee ceiling. Leave the payment `confirmed` so it keeps
    //     its merchant balance and stays in the settle tick's re-drive set — but
    //     say so out loud, because a silent `return` is why this took a crash to
    //     find.
    const prior = await queryOne<{ tx_hash: string; amount: string }>(
      `SELECT tx_hash, amount FROM blockchain_transactions
        WHERE payment_id = $1 AND direction = 'sweep'
        ORDER BY created_at DESC LIMIT 1`,
      [paymentId],
    );
    if (prior) {
      const adopted = await query<{ id: string }>(
        `UPDATE payments SET status = 'swept' WHERE id = $1 AND status = 'confirmed'
         RETURNING id`,
        [paymentId],
      );
      if (adopted.length > 0) {
        logger.warn(
          { paymentId, txHash: prior.tx_hash, amount: prior.amount },
          'sweep: nothing left to move but a prior sweep tx exists — completing the ' +
            'interrupted transition and marking swept',
        );
        // The merchant never got this one either, for the same reason.
        enqueueWebhook({
          paymentId,
          event: 'payment.swept',
          overrides: { status: 'swept', txHash: prior.tx_hash, amount: prior.amount },
        }).catch((err) => logger.warn({ err, paymentId }, 'swept webhook enqueue failed'));
      }
      // The payout is left to the settle tick's `swept` pass rather than fired
      // here: it already handles "swept with no active payout", under the same
      // guards, for exactly this case.
      return;
    }
    logger.warn(
      { paymentId, network: payment.network, asset: payment.asset },
      'sweep: nothing to move (below the minimum sweep amount, or deferred by the ' +
        'adapter) — payment stays confirmed and will be re-driven',
    );
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

/**
 * How many expired deposit addresses the late-payment reaper reads per pass.
 * Each one is a chain RPC round trip, so this is a hard ceiling on the load the
 * reaper can put on a node — 50/min, whatever the expiry rate.
 */
const LATE_DEPOSIT_SCAN_LIMIT = 50;

/**
 * Funds that arrive AFTER a payment expired.
 *
 * This was the quietest hole in the system. processExpiry flips the payment to
 * `expired`; every listener rebuilds its watch set from
 * `status IN ('waiting','confirming','partial')`, so within thirty seconds the
 * address is out of the RPC filter entirely. A transfer to it after that point
 * produces NOTHING — no blockchain_transactions row, no unexpected_deposits
 * row, no log line, no webhook. The money is at an address whose key we can
 * derive and which nobody has any reason to look at. On Bitcoin it is routine
 * rather than exceptional: the listener only counts CONFIRMED transactions, so
 * anyone who broadcasts in the last twenty minutes of a thirty-minute window
 * and gets mined ten minutes later lands here.
 *
 * The fix is not a new state. `unexpected_deposits` already exists for exactly
 * this, and already documents this case: when `asset` equals `expected_asset`
 * the row IS a late payment rather than a wrong asset. It is a ledger of
 * arrivals a human can act on, it is never summed into a balance, and the
 * merchant panel already lists it with a nav badge and a one-click recover
 * button that sweeps the address by HD index. So: read the balance of recently
 * expired deposit addresses and write the row. Money that was invisible becomes
 * money on a screen.
 *
 * The payment itself is NOT credited or revived. Reviving it would settle an
 * invoice the merchant has already treated as dead, possibly after refunding or
 * re-billing the customer; and crediting an expired payment would put funds
 * into a withdrawable balance on the strength of a balance read rather than a
 * transfer we actually saw. Recovery is deliberately a decision, not a default.
 *
 * Cost control, because this runs every minute against a live node: only
 * addresses whose payment expired within the last 24 hours, thinned out with
 * age (every tick for ten minutes, then every tenth minute to two hours, then
 * hourly), skipping any address that already has a row, capped at
 * LATE_DEPOSIT_SCAN_LIMIT per pass, newest first.
 */
async function reapLateDeposits(): Promise<void> {
  const candidates = await query<{
    id: string;
    deposit_address: string;
    network: string;
    asset: string;
  }>(
    `SELECT e.id, e.deposit_address, e.network, e.asset
       FROM (
         SELECT p.id, p.deposit_address, p.network, p.asset, p.expires_at,
                floor(extract(epoch FROM (now() - p.expires_at)) / 60)::int AS mins
           FROM payments p
          WHERE p.status = 'expired'
            AND p.expires_at > now() - interval '24 hours'
       ) e
      WHERE (e.mins <= 10 OR (e.mins <= 120 AND e.mins % 10 = 0) OR e.mins % 60 = 0)
        AND NOT EXISTS (
          SELECT 1 FROM unexpected_deposits ud
           WHERE lower(ud.deposit_address) = lower(e.deposit_address)
        )
      ORDER BY e.expires_at DESC
      LIMIT $1`,
    [LATE_DEPOSIT_SCAN_LIMIT],
  );

  for (const p of candidates) {
    try {
      const network = parseNetwork(p.network);
      const adapter = adapterFor(network); // throws if the chain is disabled
      const asset = parseAsset(network, p.asset);
      const balanceHuman = await adapter.balanceOf(p.deposit_address, asset.symbol);

      // Compared as BigInt at the ledger scale — never as a float, and never
      // against a global floor. `minSweep` is the asset's own: 1 USDT on BSC,
      // 20 USDT on Ethereum where the gas can exceed the payment. Below it the
      // funds cannot be moved at all, so a row would be an alert nobody can act
      // on; the debug line keeps it findable if someone goes looking.
      if (toAccountingUnits(balanceHuman) < toAccountingUnits(asset.minSweep)) {
        if (toAccountingUnits(balanceHuman) > 0n) {
          logger.debug(
            { paymentId: p.id, balance: balanceHuman, asset: asset.symbol },
            'settle: dust at an expired deposit address, below the minimum worth sweeping',
          );
        }
        continue;
      }

      // tx_hash is synthetic: a balance read tells us the funds are there, not
      // which transfer brought them (the listener never saw it — that is the
      // whole bug). It still carries the UNIQUE (tx_hash, log_index) that makes
      // this idempotent, and recovery works off deposit_address +
      // derivation_index + asset, never off the hash.
      await recordUnexpectedDeposit({
        network,
        asset,
        amountHuman: balanceHuman,
        depositAddress: p.deposit_address,
        txHash: `late:${p.id}`,
        logIndex: 0,
      });

      logger.warn(
        {
          paymentId: p.id,
          network: p.network,
          asset: asset.symbol,
          amount: balanceHuman,
          depositAddress: p.deposit_address,
        },
        'settle: funds found at the deposit address of an EXPIRED payment — recorded ' +
          'for recovery, NOT credited to the payment',
      );

      // Additive event: the merchant learns money turned up late and can honour
      // or refund it. Best-effort — an unreachable webhook endpoint must not
      // stop the next candidate being scanned.
      enqueueWebhook({
        paymentId: p.id,
        event: 'payment.late',
        overrides: { status: 'expired', amount: balanceHuman },
      }).catch((err) => logger.warn({ err, paymentId: p.id }, 'late webhook enqueue failed'));
    } catch (err) {
      // One dead RPC or one disabled chain must not stop the scan.
      logger.warn({ err, paymentId: p.id }, 'settle: late-deposit check failed');
    }
  }
}

async function processSettle(): Promise<void> {
  // 1) Confirmed-but-unswept -> (re)enqueue sweep, via enqueueSweep, which is
  // the only thing here that can actually create a job (see its comment).
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
  let enqueued = 0;
  for (const p of confirmed) {
    try {
      if (await enqueueSweep(p.id)) enqueued += 1;
    } catch (err) {
      // Redis hiccup on one payment must not abandon the rest of the batch.
      logger.warn({ err, paymentId: p.id }, 'settle: sweep enqueue failed');
    }
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
      asset: string;
    }>(
      // `p.asset` is in the projection because the payout below has to be
      // requested IN IT. Without it requestPayout ran parseAsset(network,
      // undefined), which resolves to the network default — USDT — so a swept
      // USDC or DAI or BNB payment was settled by sending the merchant USDT,
      // drawn from a balance that had nothing to do with it, while the real
      // USDC balance stayed fully withdrawable. The primary path (processSweep)
      // always got this right; only this recovery path, which by definition
      // only runs after the primary one failed, was crossing assets.
      `SELECT p.id, p.client_id, p.amount_received, p.network, p.asset
         FROM payments p
         JOIN clients c ON c.id = p.client_id
        WHERE p.status = 'swept'
          AND (
            (p.network = 'BEP20' AND c.payout_wallet IS NOT NULL) OR
            (p.network = 'TRC20' AND c.payout_wallet_trc20 IS NOT NULL) OR
            (p.network = 'ERC20' AND c.payout_wallet_erc20 IS NOT NULL) OR
            (p.network = 'BTC'   AND c.payout_wallet_btc   IS NOT NULL)
          )
          -- The broadcast_at test is the whole point of this guard.
          --
          -- markFailed stamps status=failed on ANY throw out of the broadcast,
          -- and it deliberately does not clear broadcast_at — because a throw
          -- AFTER the node accepted the transfer looks identical to one before
          -- it. Matching on status alone read failed as "nothing went out" and
          -- minted a SECOND payout for the same payment, with a fresh nonce and
          -- no stored signed bytes, so every re-broadcast defence in
          -- chainBroadcast.ts fell through vacuously and the merchant was paid
          -- twice out of the central wallet. broadcast_at means "a transaction
          -- may exist on chain": once it is set, no automatic path may create
          -- another payout for this payment. A human resolves it — see the
          -- stalled-payout warning below.
          --
          -- 'unresolved' is named as well as covered by broadcast_at. Today
          -- recordBroadcastFailure only ever writes it WITH broadcast_at set, so
          -- the status test is redundant — but payoutService's reservation sums
          -- (getBalanceWith, getAllBalances) list it explicitly and say in a
          -- comment that this guard describes the same set. Leaving it implied
          -- here is how the three drift apart.
          AND NOT EXISTS (
            SELECT 1 FROM payouts po
             WHERE po.payment_id = p.id
               AND (
                 po.status IN ('pending','processing','sent','confirmed','unresolved')
                 OR po.broadcast_at IS NOT NULL
               )
          )`,
    );
    for (const p of swept) {
      try {
        await requestPayout({
          clientId: p.client_id,
          amount: p.amount_received,
          paymentId: p.id,
          network: p.network,
          // Settle the asset that actually arrived, exactly as processSweep
          // does. Never the network default.
          asset: p.asset,
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
      {
        selected: confirmed.length,
        enqueued,
        capped: confirmed.length === SETTLE_BATCH_LIMIT,
      },
      'settle: re-drove sweeps for confirmed payments',
    );
  }

  // 2b) Say the quiet parts out loud.
  //
  // Both of the states this tick can no longer resolve on its own are otherwise
  // completely silent — the row simply stops being selected, which is precisely
  // how money ends up somewhere nobody looks. Neither query is a fix; they are
  // the reason an operator finds out in fifteen minutes instead of never. Both
  // are also visible in the admin panel: stalled payments under status
  // `confirmed`, held payouts under status `failed` with an error.
  try {
    const stalled = await queryOne<{ n: string; oldest: string | null }>(
      `SELECT count(*)::text AS n, min(confirmed_at)::text AS oldest
         FROM payments
        WHERE status = 'confirmed'
          AND confirmed_at < now() - interval '15 minutes'`,
    );
    if (stalled && Number(stalled.n) > 0) {
      logger.warn(
        { count: Number(stalled.n), oldestConfirmedAt: stalled.oldest },
        'settle: payments confirmed but still unswept after 15 minutes — funds are ' +
          'sitting at deposit addresses (check the gas wallet and the chain RPC)',
      );
    }

    const held = await queryOne<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM payments p
        WHERE p.status = 'swept'
          AND EXISTS (
            SELECT 1 FROM payouts po
             WHERE po.payment_id = p.id
               AND po.status NOT IN ('pending','processing','sent','confirmed')
               AND po.broadcast_at IS NOT NULL
          )`,
    );
    if (held && Number(held.n) > 0) {
      logger.warn(
        { count: Number(held.n) },
        'settle: payouts `unresolved` (or legacy `failed`) AFTER broadcasting — held ' +
          'for a human, NOT retried automatically; the gross stays reserved, so the ' +
          'merchant cannot settle it either until someone checks the explorer',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'settle: stalled-state counters failed');
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

  // 4) Funds sitting at the address of a payment that already expired.
  try {
    await reapLateDeposits();
  } catch (err) {
    // Same rule as above: this reads a chain, and a chain being unreachable
    // must never take the sweep and payout passes down with it.
    logger.error({ err }, 'settle: late-deposit reaper failed');
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
    // Worker.close() waits for ACTIVE jobs to finish, with no bound of its own.
    // A sweep job blocks on a chain confirmation, so a deploy could hold this
    // process open past Docker's 30s and pm2's kill_timeout — at which point
    // SIGKILL lands mid-sweep, after the transfer is broadcast and before the
    // `status = 'swept'` write, and the payment is stranded (processSweep's
    // prior-tx adoption above exists to repair exactly that). Exiting on our
    // own terms at 25s keeps the kill inside the window we chose rather than
    // one the supervisor chose. Mirrors the API's guard in index.ts.
    const forced = setTimeout(() => {
      logger.error('worker drain timed out; forcing exit');
      process.exit(1);
    }, 25_000);
    forced.unref();
    await Promise.allSettled(workers.map((w) => w.close()));
    clearTimeout(forced);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
