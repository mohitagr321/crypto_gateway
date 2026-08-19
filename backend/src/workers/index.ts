/**
 * Worker process (standalone: `node dist/workers/index.js`).
 *
 * BullMQ Workers for the queues declared in queues.ts:
 *   webhook      — deliver signed webhooks with retry (webhookService.dispatch)
 *   sweep        — move confirmed deposit funds deposit->central (gas-fund if needed)
 *   payout       — broadcast USDT payout (payoutService.executePayout)
 *   expiry       — repeatable: mark stale `waiting` payments as `expired`
 *   settle       — repeatable safety net: re-drives sweeps and payouts,
 *                  reconciles paid invoices, reaps funds that arrived at an
 *                  expired payment's address, and re-drives webhook deliveries
 *                  the queue never received or has given up on
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
import { reapExpiredApprovals } from '../services/loginApprovalService';
import {
  QUEUE_NAMES,
  scheduleExpiryJob,
  scheduleSettleJob,
  scheduleSubscriptionJob,
  sweepQueue,
  SweepJob,
  PayoutJob,
  AdminWithdrawJob,
  redeliverWebhook,
  webhookBackoffMs,
  WEBHOOK_ATTEMPTS,
  WEBHOOK_RETRY_SPAN_MS,
} from './queues';
import { dispatch, enqueueWebhook } from '../services/webhookService';
import { executePayout, requestPayout } from '../services/payoutService';
import { executeAdminWithdrawal } from '../services/adminCommissionService';
import { adapterFor, parseNetwork } from '../blockchain/networks';
import { parseAsset } from '../blockchain/assets';
import { reconcilePaidInvoices } from '../services/invoiceService';
import { runDueSubscriptions } from '../services/subscriptionService';
import { recordUnexpectedDeposit } from '../services/unexpectedDepositService';
import { fromAccountingUnits, toAccountingUnits } from '../utils/money';

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
// Reconciling what the sweep ACTUALLY moved against what the payment was
// credited with.
//
// The sweep is balance-based on purpose — the adapters read the live on-chain
// balance because that, not `amount_received`, is what can physically be
// transferred. The credit is event-based: a listener saw a transfer while the
// payment was still in ('waiting','confirming','partial') and added it up.
//
// Those two disagree whenever funds land at the deposit address AFTER the
// payment was promoted. recordIncoming only matches the live statuses, so a
// later transfer is not credited; and once the payment leaves those statuses
// its address drops out of every listener's watch set within thirty seconds, so
// a later transfer than that is not even RECORDED. Either way the sweep still
// moves the whole balance to the central wallet, where it is summed into
// admin commission with no payout to offset it. The merchant's customer paid;
// the merchant was paid less; the difference became withdrawable house money.
//
// So: before the payment leaves `confirmed`, make the ledger say what the chain
// did.
//
//  * SAME ASSET as the payment — this is a late payment for this invoice, from
//    the customer who was already paying it. Raise `amount_received` to what we
//    actually moved, so the auto payout a few lines below settles all of it and
//    the merchant's balance reflects their own money. Never lower it: the guard
//    is `amount_received < $2`, so a partial re-sweep can never revoke credit.
//  * DIFFERENT ASSET — deliberately NOT credited. Crediting USDC into a USDT
//    balance at 1:1 is a real loss the moment the two diverge; that is what
//    `unexpected_deposits` exists for.
//
// Either way, resolve the `unexpected_deposits` rows for the address we just
// emptied. A recovery row still pointing at an address with nothing in it sends
// an operator (or a merchant clicking "recover") to sweep a zero balance.
// ---------------------------------------------------------------------------
async function reconcileSweptExcess(args: {
  paymentId: string;
  depositAddress: string;
  network: string;
  paymentAsset: string;
  sweptAsset: string;
  amountReceived: string;
  balanceHuman: string;
  txHash: string;
}): Promise<void> {
  // BigInt at the ledger scale, never a float and never a global decimals
  // constant — both sides are NUMERIC(38,18) strings.
  const moved = toAccountingUnits(args.balanceHuman);
  const credited = toAccountingUnits(args.amountReceived);
  const excess = moved - credited;
  if (excess === 0n) return;

  if (excess < 0n) {
    // We moved LESS than the payment was credited with. Not a late arrival —
    // either a partial sweep or a credit that never really arrived. Nothing to
    // reconcile automatically; the merchant balance stands and a human decides.
    logger.error(
      {
        paymentId: args.paymentId,
        moved: args.balanceHuman,
        credited: args.amountReceived,
        asset: args.sweptAsset,
        txHash: args.txHash,
      },
      'sweep moved LESS than the payment was credited with — the credit is not ' +
        'backed by the funds that reached central; check the deposit address',
    );
    return;
  }

  logger.error(
    {
      paymentId: args.paymentId,
      moved: args.balanceHuman,
      credited: args.amountReceived,
      excess: fromAccountingUnits(excess),
      asset: args.sweptAsset,
      network: args.network,
      txHash: args.txHash,
    },
    'sweep moved MORE than the payment was credited with — funds arrived at the ' +
      'deposit address after the payment was promoted',
  );

  // (1) The recovery ledger no longer points at an address we just emptied.
  // Scoped to the asset that actually moved: a USDC row is untouched by a USDT
  // sweep of the same address.
  try {
    const resolved = await query<{ id: string }>(
      `UPDATE unexpected_deposits
          SET status = 'swept', sweep_tx_hash = $2, error = NULL, updated_at = now()
        WHERE lower(deposit_address) = lower($1)
          AND asset = $3
          AND status IN ('detected','failed')
        RETURNING id`,
      [args.depositAddress, args.txHash, args.sweptAsset],
    );
    if (resolved.length > 0) {
      logger.info(
        { paymentId: args.paymentId, count: resolved.length, txHash: args.txHash },
        'sweep: resolved unexpected_deposits rows for the address it emptied',
      );
    }
  } catch (err) {
    // Bookkeeping must not abort the sweep: the transfer already happened and
    // the payment still has to reach `swept`.
    logger.error({ err, paymentId: args.paymentId }, 'sweep: unexpected_deposits resolve failed');
  }

  // (2) Credit a same-asset excess to the payment it was sent to.
  if (args.sweptAsset !== args.paymentAsset) {
    logger.warn(
      {
        paymentId: args.paymentId,
        paymentAsset: args.paymentAsset,
        sweptAsset: args.sweptAsset,
        excess: fromAccountingUnits(excess),
      },
      'sweep: excess is in a DIFFERENT asset from the payment — moved to central ' +
        'and left for recovery, deliberately NOT credited at 1:1',
    );
    return;
  }

  const credited2 = await query<{ id: string }>(
    `UPDATE payments
        SET amount_received = $2
      WHERE id = $1
        AND status = 'confirmed'
        AND amount_received < $2
      RETURNING id`,
    [args.paymentId, args.balanceHuman],
  );
  if (credited2.length > 0) {
    logger.warn(
      {
        paymentId: args.paymentId,
        from: args.amountReceived,
        to: args.balanceHuman,
        asset: args.sweptAsset,
      },
      'sweep: credited the late same-asset arrival to the payment it was sent to',
    );
  }
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

  // `log_index = -2` is a deterministic sentinel, not decoration. The column is
  // nullable and this INSERT used to omit it, so under Postgres's default NULLS
  // DISTINCT the `ON CONFLICT (tx_hash, log_index)` clause below could never
  // match and the idempotency it advertises did not exist. The listeners
  // already established the convention: a real log index for token transfers,
  // -1 for a native transfer, 0/vout on Tron and Bitcoin. -2 is the sweep, kept
  // distinct from the gas-funding rows so a top-up and a sweep that shared a
  // transaction hash could not collide.
  await query(
    `INSERT INTO blockchain_transactions
       (payment_id, direction, tx_hash, from_address, to_address, amount, token,
        asset, network, status, log_index)
     VALUES ($1, 'sweep', $2, $3, $4, $5, $6, $6, $7, 'confirmed', -2)
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

  // Reconcile what actually moved against what the payment was credited with,
  // BEFORE the status leaves `confirmed` — the credit UPDATE inside is guarded
  // on that status, so this ordering is load-bearing.
  //
  // Guarded: the transfer has already happened, so nothing here may stop the
  // payment reaching `swept`. A throw would leave it `confirmed` with an empty
  // deposit address, and the retry would take the prior-tx adoption branch and
  // skip this reconciliation entirely.
  try {
    await reconcileSweptExcess({
      paymentId,
      depositAddress: payment.deposit_address,
      network: payment.network,
      paymentAsset: payment.asset,
      sweptAsset,
      amountReceived: payment.amount_received,
      balanceHuman,
      txHash,
    });
  } catch (err) {
    logger.error(
      { err, paymentId, txHash, moved: balanceHuman, credited: payment.amount_received },
      'sweep: excess reconciliation failed — if these differ, the difference is ' +
        'sitting in central as unattributed commission; reconcile by hand',
    );
  }

  // Mark payment swept.
  //
  // This is a compare-and-set against a status that was read at the top of the
  // function, before an irreversible on-chain transfer. Discarding its result
  // is how the one case that matters stayed silent: a reorg revert (which sets
  // a promoted payment back to 'waiting') landing between the read and here
  // leaves the funds in the central wallet with NO payment in a state anything
  // will settle. It is narrow — on BSC it needs a 12-to-15 block reorg detected
  // inside the couple of seconds a just-promoted payment is still a reorg
  // candidate — but it is exactly the event an operator must be paged for, and
  // it costs one RETURNING to see it.
  const swept = await query<{ id: string }>(
    `UPDATE payments SET status = 'swept' WHERE id = $1 AND status = 'confirmed'
     RETURNING id`,
    [paymentId],
  );
  if (swept.length === 0) {
    logger.error(
      { paymentId, txHash, amount: balanceHuman, network: payment.network },
      'SWEEP MOVED FUNDS BUT THE PAYMENT WAS NO LONGER `confirmed` — the balance is ' +
        'in the central wallet with no settleable payment behind it; reconcile by hand',
    );
  }
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
/**
 * How many payments one expiry pass may age out.
 *
 * This statement used to have no LIMIT at all, and then fanned a DETACHED
 * `enqueueWebhook` out per returned row. After an outage that is thousands of
 * promises starting at once, each needing two connections from a 20-slot pool:
 * most of them reject with 'timeout exceeded when trying to connect' into a
 * `.catch` that only warns — so the merchant silently never receives
 * `payment.expired` — while the worker process's pool is pinned for ten
 * seconds, starving the sweep, payout and settle jobs that share it.
 *
 * Bounding it is safe in the way that matters: a payment that misses the cut is
 * still `waiting`, so it is still in every listener's watch set, still
 * creditable if the customer pays, and still selected by the next tick sixty
 * seconds later. The backlog drains at 500/minute instead of stampeding.
 *
 * `idx_payments_expires` (partial on status IN ('waiting','confirming')) serves
 * the inner select, so the cap is applied on an index scan, not a sort of the
 * whole table.
 */
const EXPIRY_BATCH_LIMIT = 500;

/**
 * How many `payment.expired` enqueues are in flight at once. Each one is two
 * short indexed queries and takes a pool connection, so this keeps the tick's
 * demand well inside the pool while still draining a full batch in well under
 * the BullMQ lock duration.
 */
const EXPIRY_WEBHOOK_CONCURRENCY = 5;

async function processExpiry(): Promise<void> {
  const rows = await query<{ id: string }>(
    // Same claim-then-update shape as redeliverAbandonedWebhooks below: the CTE
    // drives, so the plan is always "read 500 rows off idx_payments_expires,
    // then 500 primary-key updates" rather than anything that scales with the
    // size of the waiting set. SKIP LOCKED so two overlapping ticks (a retry,
    // or two worker hosts) split the batch instead of blocking on each other.
    `WITH due AS (
       SELECT id
         FROM payments
        WHERE status = 'waiting'
          AND expires_at < now()
        ORDER BY expires_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE payments p
        SET status = 'expired'
       FROM due d
      WHERE p.id = d.id
        AND p.status = 'waiting'
     RETURNING p.id`,
    [EXPIRY_BATCH_LIMIT],
  );
  if (rows.length === 0) return;

  logger.info(
    { count: rows.length, capped: rows.length === EXPIRY_BATCH_LIMIT },
    'expired stale waiting payments',
  );

  // Awaited in bounded chunks rather than fired off all at once. The status has
  // ALREADY moved to 'expired', so the next tick's UPDATE will not match these
  // rows again and a lost enqueue is a permanently lost merchant event — which
  // is precisely why the failures have to be counted out loud instead of
  // disappearing into a per-row warn.
  let failed = 0;
  for (let i = 0; i < rows.length; i += EXPIRY_WEBHOOK_CONCURRENCY) {
    const chunk = rows.slice(i, i + EXPIRY_WEBHOOK_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((r) =>
        enqueueWebhook({
          paymentId: r.id,
          event: 'payment.expired',
          overrides: { status: 'expired' },
        }),
      ),
    );
    settled.forEach((s, j) => {
      if (s.status === 'rejected') {
        failed += 1;
        logger.warn(
          { err: s.reason, paymentId: chunk[j].id },
          'expired webhook enqueue failed',
        );
      }
    });
  }
  if (failed > 0) {
    logger.error(
      { failed, total: rows.length },
      'expiry: payment.expired could not be enqueued for some payments — those ' +
        'merchants will never be told, and the rows are already `expired` so no ' +
        'later tick re-selects them',
    );
  }

  // Housekeeping for login_approvals, ridden along on the existing minute tick
  // rather than given a queue of its own: it is one DELETE with no fan-out and
  // no webhooks, and a second repeatable would be more moving parts than the
  // job deserves.
  //
  // Nothing depends on this running. An un-reaped row is inert — every
  // statement in loginApprovalService filters on `expires_at > now()`, so a
  // stale row cannot authorise anything. This keeps the table from growing
  // without bound, which is a disk concern, not a security one.
  try {
    const reaped = await reapExpiredApprovals();
    if (reaped > 0) logger.debug({ reaped }, 'expiry: reaped login approvals');
  } catch (err) {
    logger.warn({ err }, 'expiry: login-approval reap failed');
  }
}

// ---------------------------------------------------------------------------
// SETTLE (safety net): re-drive settlement for payments that confirmed but never
// got swept/paid out (worker was down, transient RPC failure, etc). Idempotent.
// ---------------------------------------------------------------------------
/**
 * How many stalled payments the settle tick re-drives per pass, PER HALF. The
 * tick runs every minute, so this is 500/min of catch-up capacity in each of the
 * sweep and payout passes — far above any real arrival rate, while keeping one
 * pass bounded.
 *
 * Both halves are now capped. The payout half used to have no LIMIT at all: it
 * selected every `swept` payment ever taken, once a minute, forever, and ran a
 * full requestPayout per row in sequence. `swept` is the terminal state of every
 * successful payment and nothing ever leaves it, so that set only grows.
 *
 * A CAP ALONE WOULD STARVE. Ordered purely oldest-first, a row that can never
 * make progress — a payment below its asset's minSweep can never leave
 * `confirmed`, and on Ethereum that is any ERC20 payment under 20 USDT — sits at
 * the head of every batch forever and the cap means nothing behind it is ever
 * reached. So the order is `settle_attempts ASC, confirmed_at ASC` and every row
 * SELECTED has its attempt counter incremented, whatever the outcome.
 *
 * That makes the cap a round-robin rather than a queue: a row with k attempts is
 * only skipped while rows with fewer than k exist, and every pass moves those
 * closer to k. So THE REMAINDER OF AN OVER-CAP BACKLOG IS PICKED UP ON THE NEXT
 * TICKS, in a bounded number of them, and no row can be starved by another —
 * which is the property a plain `ORDER BY confirmed_at LIMIT 500` did not have.
 */
const SETTLE_BATCH_LIMIT = 500;

/**
 * How many `swept` payments the settle tick examines per pass when maintaining
 * the `settle_done_at` marker (see markSettledPayments). Larger than
 * SETTLE_BATCH_LIMIT because the work is one bounded UPDATE, not a job per row.
 */
const SETTLE_MARK_LIMIT = 2_000;

/**
 * How many abandoned webhook deliveries are re-driven per pass. Each one is an
 * HTTP request against a merchant endpoint that has already been failing, so
 * this is a deliberate ceiling on how hard a recovering endpoint is hit — and on
 * how fast the backlog that exists the first time this ships is drained.
 */
const WEBHOOK_REDELIVER_LIMIT = 100;

/**
 * How long a webhook_logs row may sit with no dispatch attempt recorded at all
 * before the settle tick assumes its queue job was never created.
 *
 * `enqueueWebhook` writes the row and THEN calls webhookQueue.add. If the add
 * throws — Redis restarting, a network blip — the row exists and no job does,
 * and every caller treats the enqueue as best-effort and merely logs. Nothing
 * else ever looks at it again.
 *
 * Generous, because the only cost of waiting is delay and the cost of being
 * wrong is a duplicate delivery: a first attempt is normally recorded within
 * seconds, and this only misfires if the webhook worker is more than fifteen
 * minutes behind on its FIRST attempt for a row.
 */
const WEBHOOK_UNDISPATCHED_GRACE_MS = 15 * 60_000;

/**
 * Oldest webhook the reaper will re-drive.
 *
 * The queue's own tail already covers any outage up to WEBHOOK_RETRY_SPAN_MS
 * (~24h), so this window exists for the two things it cannot cover: a delivery
 * that was never enqueued, and an outage longer than the tail. Past three days
 * an undelivered event is a conversation with the merchant, not a retry —
 * replaying a week of order events into a system that has moved on is its own
 * kind of damage, and it is also what would happen the FIRST time this ships, to
 * every webhook the old eleven-minute tail ever abandoned.
 *
 * Older rows are not deleted and not hidden: they stay in webhook_logs, still
 * `success = false`, and redelivery becomes an explicit operator/merchant action
 * (queues.ts exports redeliverWebhook for exactly that).
 */
const WEBHOOK_REDELIVER_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

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

/**
 * Mark `swept` payments the settle tick has provably finished with.
 *
 * WHY THIS EXISTS. Step 2 below anti-joins `swept` payments against payouts.
 * `swept` is where every successful payment ends and nothing ever leaves it, so
 * without a marker that query re-reads the entire successful history of the
 * gateway every sixty seconds. At a hundred thousand payments a day that is not
 * a slow query, it is a query whose cost grows forever until it dominates the
 * database.
 *
 * WHAT MAY BE MARKED. Only a payment whose payout has reached a state that
 * NOTHING can move it back out of:
 *
 *   sent / confirmed / unresolved   — money is on the wire or has landed, and
 *                                     `unresolved` is terminal for automation
 *                                     by design (only a human moves it on).
 *   broadcast_at IS NOT NULL        — a transaction may exist on chain. It is
 *                                     stamped before signing and is NEVER
 *                                     cleared anywhere in the codebase.
 *
 * That set is a strict subset of step 2's exclusion list and it is MONOTONE:
 * once true for a payment it is true forever. So the marker can only ever hide
 * rows that step 2 would itself refuse to act on, for the same reason, forever —
 * which is what "provably already handled" has to mean before it is safe to
 * stop looking at a row that represents money.
 *
 * `pending` and `processing` are deliberately NOT markable even though step 2
 * excludes them: a payout that fails BEFORE broadcast goes back to `failed` with
 * broadcast_at NULL, and step 2 is then correct to mint a fresh one. Marking on
 * those would strand exactly the payments this safety net exists for.
 *
 * THE `LIMIT` APPLIES TO MARKABLE ROWS, NOT TO CANDIDATES. The markability test
 * lives INSIDE the windowed subquery on purpose. With it outside, any swept row
 * that can never be marked AND is never selected by step 2 — a merchant with no
 * payout wallet for that chain is excluded by step 2's wallet guard, so its
 * `settle_attempts` never moves — parks itself permanently at the head of the
 * window. Two thousand of those and this pass marks nothing, ever, and the scan
 * bound it exists to provide quietly stops existing. Filtering first means the
 * window always contains work, so the marker converges: a marked row leaves the
 * candidate set for good, and anything past the cap is marked on a later tick.
 */
async function markSettledPayments(): Promise<number> {
  const marked = await query<{ id: string }>(
    `UPDATE payments p
        SET settle_done_at = now()
      WHERE p.id IN (
              SELECT c.id
                FROM payments c
               WHERE c.status = 'swept'
                 AND c.settle_done_at IS NULL
                 AND EXISTS (
                       SELECT 1 FROM payouts po
                        WHERE po.payment_id = c.id
                          AND (
                            po.status IN ('sent','confirmed','unresolved')
                            OR po.broadcast_at IS NOT NULL
                          )
                     )
               ORDER BY c.settle_attempts ASC, c.confirmed_at ASC NULLS FIRST
               LIMIT $1
            )
      RETURNING p.id`,
    [SETTLE_MARK_LIMIT],
  );
  return marked.length;
}

/** Count one attempt against every row a settle pass selected. */
async function bumpSettleAttempts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await query(
    `UPDATE payments SET settle_attempts = settle_attempts + 1 WHERE id = ANY($1::text[])`,
    [ids],
  );
}

/**
 * Step 1 of the settle tick: confirmed-but-unswept -> (re)enqueue sweep, via
 * enqueueSweep, which is the only thing here that can actually create a job (see
 * its comment).
 *
 * Bounded and round-robin: see SETTLE_BATCH_LIMIT. Previously this selected
 * EVERY confirmed payment; then it was capped at 500 strictly oldest-first,
 * which a permanently unsweepable row (below the asset's minSweep) parks itself
 * at the head of forever.
 */
async function redriveSweeps(): Promise<{ selected: number; enqueued: number }> {
  const confirmed = await query<{ id: string }>(
    `SELECT id FROM payments
      WHERE status = 'confirmed'
      ORDER BY settle_attempts ASC, confirmed_at ASC NULLS FIRST
      LIMIT $1`,
    [SETTLE_BATCH_LIMIT],
  );
  // Count the attempt BEFORE doing the work, so a pass that dies half way
  // through cannot re-select the same head next minute and starve the tail.
  await bumpSettleAttempts(confirmed.map((p) => p.id));
  let enqueued = 0;
  for (const p of confirmed) {
    try {
      if (await enqueueSweep(p.id)) enqueued += 1;
    } catch (err) {
      // Redis hiccup on one payment must not abandon the rest of the batch.
      logger.warn({ err, paymentId: p.id }, 'settle: sweep enqueue failed');
    }
  }
  return { selected: confirmed.length, enqueued };
}

/**
 * Step 2 of the settle tick: swept + payout wallet set + no active payout ->
 * (re)enqueue the auto payout.
 *
 * The wallet-set guard is per-network: a payment settles on ITS network, using
 * payout_wallet (BEP20), payout_wallet_trc20 (TRC20) or payout_wallet_erc20
 * (Ethereum). This avoids re-enqueuing a payout for a merchant who only
 * configured one chain's wallet — it would just throw, every minute, forever.
 *
 * Bounded three ways, because this pass had no LIMIT, no ORDER BY and no marker
 * at all, and ran a full requestPayout — a transaction, an advisory lock and
 * three growing aggregates — per matched row, in sequence, once a minute, over
 * every payment the gateway had ever settled:
 *   * settle_done_at   — rows whose payout has provably reached the wire are
 *                        excluded from the scan for good (markSettledPayments).
 *   * ORDER BY + LIMIT — the same round-robin cap as the sweep half, so a row
 *                        that throws every time cannot monopolise the batch and
 *                        the remainder is picked up on the following ticks.
 *   * the caller guards it, so it cannot take the rest of the tick down.
 */
async function redrivePayouts(): Promise<{ selected: number; marked: number }> {
  let marked = 0;
  try {
    marked = await markSettledPayments();
  } catch (err) {
    // Purely an optimisation: the anti-join below is still correct without it,
    // just as expensive as it used to be.
    logger.warn({ err }, 'settle: settle_done_at marking pass failed');
  }

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
          -- Rows whose payout has provably reached the wire, excluded once and
          -- for good so this stops being a scan of all history. The full
          -- NOT EXISTS below is still applied to everything that survives, so
          -- correctness never depends on the marker — only cost does. See
          -- markSettledPayments for why the marking predicate is monotone.
          AND p.settle_done_at IS NULL
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
          )
        ORDER BY p.settle_attempts ASC, p.confirmed_at ASC NULLS FIRST
        LIMIT $1`,
    [SETTLE_BATCH_LIMIT],
  );
  // Count the attempt against every row selected, whatever the outcome below —
  // that is what makes the LIMIT a round-robin instead of a queue whose head can
  // never be passed.
  await bumpSettleAttempts(swept.map((p) => p.id));
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
  return { selected: swept.length, marked };
}

/**
 * Re-drive webhook deliveries the queue can no longer be relied on to make.
 *
 * TWO DIFFERENT LOSSES, one query.
 *
 * (a) NEVER ENQUEUED. enqueueWebhook writes the webhook_logs row and THEN calls
 *     webhookQueue.add. If the add throws — Redis restarting, a network blip —
 *     the row exists and the job does not, and every call site treats the
 *     enqueue as best-effort and merely logs. Such a row has no dispatch result
 *     recorded at all: no status_code, no response_body. Nothing else in the
 *     product ever looked at it again.
 *
 * (b) TAIL EXHAUSTED. Even a 24-hour tail runs out, and a merchant whose
 *     endpoint was down longer than that has a paid order they never heard
 *     about. One automatic second chance costs a request and can turn a lost
 *     order into a fulfilled one.
 *
 * SAFETY AGAINST DOUBLE DELIVERY. The queue is authoritative while it is still
 * retrying, so (b) only considers rows older than the entire retry span — the
 * reaper can never race a live job. Within a group, only the NEWEST row for
 * (payment_id, event) is a candidate, so the thirty-odd attempt rows a failed
 * delivery leaves behind produce ONE redelivery, not thirty. `redelivered_at`
 * then stops that row being picked again on the next tick, sixty seconds later,
 * before its own new attempt rows exist.
 *
 * Delivery is at-least-once regardless (a receiver that processed a request we
 * timed out on is indistinguishable from one that did not), and every payload
 * carries `event` + `paymentId` for receiver-side dedupe.
 */
async function redeliverAbandonedWebhooks(): Promise<number> {
  const claimed = await query<{ id: string; event: string; payment_id: string | null }>(
    `WITH candidates AS (
       SELECT w.id
         FROM webhook_logs w
        WHERE w.success = false
          AND w.redelivered_at IS NULL
          AND w.payment_id IS NOT NULL
          AND w.created_at > now() - ($2::double precision * interval '1 millisecond')
          AND (
            -- (a) the queue never got it: no attempt was ever recorded
            (w.status_code IS NULL AND w.response_body IS NULL
             AND w.created_at < now() - ($3::double precision * interval '1 millisecond'))
            OR
            -- (b) the queue has provably given up on it
            w.created_at < now() - ($4::double precision * interval '1 millisecond')
          )
          -- Newest row of its (payment, event) group, and nothing in the group
          -- ever succeeded. Both tests use the SAME group, so a later success
          -- retires every older attempt row with it.
          AND NOT EXISTS (
            SELECT 1 FROM webhook_logs s
             WHERE s.payment_id = w.payment_id
               AND s.event = w.event
               AND (s.success OR s.created_at > w.created_at)
          )
        ORDER BY w.created_at ASC
        LIMIT $1
        -- Two settle ticks overlapping (a retry, or two worker hosts) must not
        -- both claim the same row and deliver it twice.
        FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_logs w
        SET redelivered_at = now()
       FROM candidates c
      WHERE w.id = c.id
     RETURNING w.id, w.event, w.payment_id`,
    [
      WEBHOOK_REDELIVER_LIMIT,
      WEBHOOK_REDELIVER_MAX_AGE_MS,
      WEBHOOK_UNDISPATCHED_GRACE_MS,
      WEBHOOK_RETRY_SPAN_MS,
    ],
  );

  let requeued = 0;
  for (const row of claimed) {
    try {
      await redeliverWebhook(row.id);
      requeued += 1;
    } catch (err) {
      // The row is already stamped, so this one is not retried automatically —
      // deliberately: a Redis that rejects an add will reject the next two
      // hundred as well, and a tick that re-stamps and re-adds every minute is a
      // storm, not a recovery. The row stays in webhook_logs, still
      // unsuccessful, and an operator can resend it.
      logger.error(
        { err, webhookLogId: row.id, event: row.event, paymentId: row.payment_id },
        'settle: webhook redelivery could not be enqueued — resend it by hand',
      );
    }
  }
  if (requeued > 0) {
    logger.warn(
      { requeued, capped: claimed.length === WEBHOOK_REDELIVER_LIMIT },
      'settle: re-drove webhook deliveries the queue had abandoned or never received',
    );
  }
  return requeued;
}

async function processSettle(): Promise<void> {
  // 1) Confirmed-but-unswept -> (re)enqueue sweep.
  //
  // Each half of this tick is independently guarded: the payout pass is the only
  // thing that pays a merchant, and a failure in the sweep pass must not take it
  // down with it (or the other way round).
  let sweeps = { selected: 0, enqueued: 0 };
  try {
    sweeps = await redriveSweeps();
  } catch (err) {
    logger.error({ err }, 'settle: sweep re-drive pass failed');
  }

  // 2) Swept + payout wallet set + no active payout -> (re)enqueue auto payout.
  let payouts = { selected: 0, marked: 0 };
  if (config.settlement.autoPayoutEnabled) {
    try {
      payouts = await redrivePayouts();
    } catch (err) {
      logger.error({ err }, 'settle: payout re-drive pass failed');
    }
  }

  if (sweeps.selected > 0 || payouts.selected > 0) {
    // `capped` is the single clearest early warning that settlement has stalled:
    // it means the backlog is at or over a whole pass's worth of catch-up
    // capacity. The round-robin ordering means the remainder is picked up on
    // following ticks rather than starved, but a `capped` that stays true tick
    // after tick is an outage, not a burst — alert on it.
    logger.info(
      {
        confirmedSelected: sweeps.selected,
        enqueued: sweeps.enqueued,
        confirmedCapped: sweeps.selected === SETTLE_BATCH_LIMIT,
        sweptSelected: payouts.selected,
        sweptCapped: payouts.selected === SETTLE_BATCH_LIMIT,
        markedDone: payouts.marked,
      },
      'settle: re-drove settlement',
    );
  }

  // 2b) Say the quiet parts out loud.
  //
  // Every state this tick can no longer resolve on its own is otherwise
  // completely silent — the row simply stops being selected, which is precisely
  // how money ends up somewhere nobody looks. None of these queries is a fix;
  // they are the reason an operator finds out in fifteen minutes instead of
  // never. All three are also visible in the admin panel: stalled payments under
  // status `confirmed`, held payouts under status `failed`/`unresolved` with an
  // error, and the swept backlog under status `swept`.
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

    // The third silent state, and the one the payout half's cap can produce:
    // swept payments that have not reached `settle_done_at`. A handful is the
    // normal in-flight window (a payout that is still `pending` has not been
    // marked yet). A number that keeps growing means the payout pass is capped
    // every tick, or a merchant has no payout wallet for that chain, or a payout
    // is wedged in `pending` — all of them money sitting in the central wallet
    // with the merchant's name on it. Counting the whole backlog (not just what
    // this pass selected) is the point: the cap hides the size.
    //
    // ONLY MEANINGFUL UNDER AUTO PAYOUT, and only safe to run there.
    // `settle_done_at` is stamped exclusively by markSettledPayments, which only
    // runs inside the payout pass, and it is only ever stampable from a payout
    // carrying a payment_id — which merchant-initiated payouts do not have
    // (routes/payouts.ts requests them by amount, not by payment). So with
    // AUTO_PAYOUT_ENABLED off — the default — nothing is ever marked, every
    // swept payment ever taken matches, and this becomes (a) a WARN every sixty
    // seconds saying the merchant has not been paid when settling on demand is
    // exactly how that deployment works, and (b) an unbounded count over the
    // whole successful history once a minute, which is the very defect
    // `settle_done_at` was added to remove.
    if (config.settlement.autoPayoutEnabled) {
      const backlog = await queryOne<{ n: string; oldest: string | null }>(
        `SELECT count(*)::text AS n, min(confirmed_at)::text AS oldest
           FROM payments
          WHERE status = 'swept'
            AND settle_done_at IS NULL
            AND confirmed_at < now() - interval '30 minutes'`,
      );
      if (backlog && Number(backlog.n) > 0) {
        logger.warn(
          { count: Number(backlog.n), oldestConfirmedAt: backlog.oldest },
          'settle: payments swept more than 30 minutes ago with no payout on the wire — ' +
            'the funds are in the central wallet and the merchant has not been paid',
        );
      }
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

  // 5) Webhooks the queue never received, or has given up on.
  try {
    await redeliverAbandonedWebhooks();
  } catch (err) {
    // Bookkeeping relative to the money path; never fail the tick for it.
    logger.error({ err }, 'settle: webhook redelivery pass failed');
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
    {
      connection,
      concurrency: 10,
      // Resolves `backoff: { type: 'custom' }` on the webhook queue. BullMQ has
      // no capped-exponential builtin, and an UNcapped one is what limited a
      // delivery's whole life to about eleven minutes (see queues.ts): eight
      // attempts was the only way to keep the last gap sane. With the cap, the
      // attempt count buys span instead of an ever-doubling wait.
      //
      // This must ship with queues.ts. BullMQ throws `Unknown backoff strategy
      // custom` if a worker without this setting picks up such a job.
      settings: { backoffStrategy: (attemptsMade: number) => webhookBackoffMs(attemptsMade) },
    },
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
    // Without this listener BullMQ's re-emitted internal errors reach a bare
    // console.error — unstructured stderr, outside the pino pipeline, so a
    // worker that has lost Redis looks like a worker with nothing to do.
    w.on('error', (err) => {
      logger.error({ queue: w.name, err }, 'bullmq worker error');
    });
    // `stalled` is the signal that fires when a job's lock expired while it was
    // still active — the orphaned-sweep shape the shutdown guard below exists
    // for. The re-run is safe (chainBroadcast pins the nonce and the signed
    // bytes, and processSweep re-reads the live balance), but it must be
    // VISIBLE: a sweep that stalls repeatedly is a chain call that never
    // returns, not a transient.
    w.on('stalled', (jobId) => {
      logger.warn({ queue: w.name, jobId }, 'bullmq job stalled and will be re-run');
    });
  }
  return workers;
}

/**
 * How long the repeatable-tick registration may take before the boot is
 * declared failed.
 *
 * This is not a nicety. If Redis is unreachable at boot, `expiryQueue.add` does
 * NOT reject — it awaits BullMQ's `waitUntilReady`, which resolves only on
 * `'ready'` and rejects only on `'end'`, and ioredis's default retry strategy
 * reconnects forever without ever reaching `'end'`. So the await HANGS, main()
 * never reaches the rest of the boot, and the process sits there logging
 * "starting workers" and consuming nothing: no sweeps, no payouts, no
 * webhooks, no expiry — with no error, no crash and a zero exit code that no
 * supervisor will act on. A silent total worker outage is the worst possible
 * shape for this process, because everything it does is a safety net.
 */
const BOOT_TIMEOUT_MS = 20_000;

async function main(): Promise<void> {
  logger.info(
    {
      webhookAttempts: WEBHOOK_ATTEMPTS,
      webhookRetrySpanMinutes: Math.round(WEBHOOK_RETRY_SPAN_MS / 60_000),
    },
    'starting workers',
  );

  // Construct the workers FIRST. Registering the repeatable ticks is the part
  // that can hang on a cold Redis, and a worker that was never constructed
  // consumes nothing even after Redis comes back — whereas a worker that
  // exists reconnects on its own. The schedule calls are idempotent by jobId,
  // so doing them second costs nothing.
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
  // Registered BEFORE the boot race below, so a deploy that lands while the
  // scheduling call is hung on a cold Redis still drains instead of being hard
  // terminated by the supervisor.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Bounded, and fatal on failure. Without the repeatable ticks there is no
  // expiry, no settle safety net and no subscription billing, so a process
  // that fails to register them must die and be restarted rather than run on
  // looking healthy.
  let bootTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.all([scheduleExpiryJob(), scheduleSettleJob(), scheduleSubscriptionJob()]),
      new Promise<never>((_, reject) => {
        bootTimer = setTimeout(
          () =>
            reject(
              new Error('repeatable job scheduling timed out — is Redis reachable?'),
            ),
          BOOT_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    logger.fatal({ err }, 'worker boot failed: could not register the repeatable ticks');
    process.exit(1);
  } finally {
    if (bootTimer) clearTimeout(bootTimer);
  }

  logger.info('worker boot complete: repeatable ticks registered');
}

// Log AND exit — deliberately not the listeners' swallow-and-continue. Every
// intentional fire-and-forget in this process already carries its own
// `.catch()`, so an unhandled rejection here is by definition unanticipated,
// and a worker in an unknown state is one that may be half way through moving
// money. Node already exits non-zero on both of these; the handlers exist so
// the last line before the exit is structured, redacted pino JSON rather than a
// raw stack on stderr.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandledRejection in worker process');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException in worker process');
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
