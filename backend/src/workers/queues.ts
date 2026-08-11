/**
 * BullMQ queue definitions + shared job options.
 *
 * Queues:
 *   webhook  — deliver signed webhook POSTs with retry/backoff.
 *   sweep    — move confirmed deposit funds to the central wallet.
 *   payout   — send net USDT to a client's payout wallet.
 *   expiry   — repeatable job marking stale waiting payments as expired.
 *
 * The API and listener ENQUEUE; the worker process CONSUMES (see workers/index.ts).
 */
import { Queue, JobsOptions } from 'bullmq';
import { bullConnectionOptions } from '../db/redis';
import { config } from '../config/env';

export const QUEUE_NAMES = {
  webhook: 'webhook',
  sweep: 'sweep',
  payout: 'payout',
  expiry: 'expiry',
  settle: 'settle',
  adminWithdraw: 'admin-withdraw',
  subscription: 'subscription',
} as const;

// Standard retry policy for blockchain jobs.
export const defaultJobOptions: JobsOptions = {
  attempts: Math.max(1, config.webhook.maxRetries),
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

// ---------------------------------------------------------------------------
// WEBHOOK RETRY POLICY
//
// This used to be `attempts: WEBHOOK_MAX_RETRIES (8)` with an uncapped
// exponential backoff of 5s. BullMQ computes gap N as 2^(N-1) * delay, so the
// seven gaps were 5s, 10s, 20s, 40s, 80s, 160s, 320s — 635 seconds. Add eight
// attempts of up to WEBHOOK_TIMEOUT_MS and the whole delivery life of a webhook
// was about ELEVEN AND A HALF MINUTES, after which the job was dropped and
// nothing anywhere re-drove it: `GET /account/webhook-logs` is read-only, and
// grep for 'redeliver' returned nothing.
//
// A merchant whose endpoint is down for a fifteen-minute deploy therefore lost
// `payment.confirmed` for every payment settled in that window, permanently.
// The customer paid, the gateway is correct, the merchant's order never ships,
// and there is nothing to click. That is a product hole, not a tuning value.
//
// So the tail is now shaped by the outage it has to survive rather than by an
// attempt count: exponential from 5s, CAPPED at one hour, with however many
// attempts it takes to span WEBHOOK_RETRY_TARGET_MS. The cap matters as much as
// the span — uncapped doubling reaches a fortnight by attempt 20 and would
// "retry" a recovered endpoint long after anyone cares.
//
// WEBHOOK_MAX_RETRIES is honoured as a FLOOR, not a ceiling: raising it extends
// the tail, lowering it cannot shorten coverage below the target, because a
// sub-day tail silently discards paid-for events. Operators who want fewer
// deliveries want the per-client circuit breaker, not a shorter tail.
// ---------------------------------------------------------------------------
export const WEBHOOK_BACKOFF_BASE_MS = 5_000;
/** No gap is ever longer than this, however many attempts have been made. */
export const WEBHOOK_BACKOFF_MAX_MS = 60 * 60_000; // 1 hour
/** How long the retry tail must keep trying before a delivery is abandoned. */
export const WEBHOOK_RETRY_TARGET_MS = 24 * 60 * 60_000; // 24 hours

/**
 * The gap before attempt `attemptsMade + 1`, in ms. Registered as the webhook
 * Worker's custom BullMQ backoff strategy (workers/index.ts) — BullMQ has no
 * capped-exponential builtin.
 *
 * Exported so the SAME curve can be used to fill `webhook_logs.next_retry_at`;
 * a displayed retry time computed by a second, private formula is a support
 * ticket waiting to happen.
 */
export function webhookBackoffMs(attemptsMade: number): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  // 2 ** n overflows to Infinity well before this matters; Math.min still
  // returns the cap, but bail early rather than rely on that.
  const raw = n > 40 ? Number.POSITIVE_INFINITY : WEBHOOK_BACKOFF_BASE_MS * 2 ** (n - 1);
  return Math.min(WEBHOOK_BACKOFF_MAX_MS, raw);
}

/** Attempts needed for the gaps to add up to `targetMs`. */
function attemptsCovering(targetMs: number): number {
  let span = 0;
  let attempts = 1;
  // The guard is belt-and-braces: with a 1h cap, 24h needs 34 attempts.
  while (span < targetMs && attempts < 500) {
    span += webhookBackoffMs(attempts);
    attempts += 1;
  }
  return attempts;
}

/** Total time spanned by the gaps before attempt `attempts`. */
function backoffSpanMs(attempts: number): number {
  let span = 0;
  for (let n = 1; n < attempts; n += 1) span += webhookBackoffMs(n);
  return span;
}

/** Total delivery attempts per webhook, floored by WEBHOOK_MAX_RETRIES. */
export const WEBHOOK_ATTEMPTS = Math.max(
  1,
  config.webhook.maxRetries,
  attemptsCovering(WEBHOOK_RETRY_TARGET_MS),
);

/**
 * Wall-clock ceiling on one delivery's whole life: every backoff gap plus the
 * request timeout each attempt may burn. The settle tick uses this to tell
 * "still being retried" from "the queue has given up", so it can never race the
 * queue into a duplicate delivery.
 */
export const WEBHOOK_RETRY_SPAN_MS =
  backoffSpanMs(WEBHOOK_ATTEMPTS) + WEBHOOK_ATTEMPTS * config.webhook.timeoutMs;

export const webhookJobOptions: JobsOptions = {
  attempts: WEBHOOK_ATTEMPTS,
  // Resolved by `settings.backoffStrategy` on the webhook Worker. BullMQ throws
  // `Unknown backoff strategy custom` if a worker consumes these jobs without
  // that setting, so the two must ship together — see workers/index.ts.
  backoff: { type: 'custom' },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

// BullMQ owns the producer connections (created from options).
const connection = bullConnectionOptions;

export const webhookQueue = new Queue(QUEUE_NAMES.webhook, {
  connection,
  defaultJobOptions: webhookJobOptions,
});

export const sweepQueue = new Queue(QUEUE_NAMES.sweep, {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: 'exponential', delay: 15_000 },
  },
});

export const payoutQueue = new Queue(QUEUE_NAMES.payout, {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: 'exponential', delay: 15_000 },
  },
});

export const expiryQueue = new Queue(QUEUE_NAMES.expiry, { connection });

export const settleQueue = new Queue(QUEUE_NAMES.settle, { connection });

export const subscriptionQueue = new Queue(QUEUE_NAMES.subscription, { connection });

export const adminWithdrawQueue = new Queue(QUEUE_NAMES.adminWithdraw, {
  connection,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 5,
    backoff: { type: 'exponential', delay: 15_000 },
  },
});

// ---- Job payload types ----
export interface WebhookJob {
  webhookLogId: string;
}
export interface SweepJob {
  paymentId: string;
}
export interface PayoutJob {
  payoutId: string;
}
export interface AdminWithdrawJob {
  withdrawalId: string;
}

/**
 * Re-drive one `webhook_logs` row through the delivery queue.
 *
 * The single entry point for redelivery, used by
 *   - the settle tick's abandoned-webhook reaper (workers/index.ts), and
 *   - operator/merchant "resend" actions in the HTTP layer.
 *
 * NO jobId: redelivery is deliberately not deduped against the original job.
 * The reasons to call this are "the first job was never created" and "the first
 * job has already been dropped", and in both cases a dedupe key that outlives
 * the job would turn the resend into a silent no-op — the same failure the
 * sweep queue's jobId comment describes at length.
 *
 * Delivery is at-least-once by design (a timeout that the receiver actually
 * processed is indistinguishable from one it did not), so a duplicate is a
 * receiver-side dedupe on (event, paymentId), not a fault.
 */
export async function redeliverWebhook(webhookLogId: string): Promise<void> {
  await webhookQueue.add('deliver', { webhookLogId } as WebhookJob);
}

/** Register the repeatable expiry sweeper (idempotent by jobId). */
export async function scheduleExpiryJob(): Promise<void> {
  await expiryQueue.add(
    'expire-stale',
    {},
    {
      repeat: { every: 60_000 }, // every minute
      jobId: 'expiry-repeatable',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}

/**
 * Repeatable safety-net: re-drives settlement for payments that confirmed but
 * never got swept/paid out (e.g. worker was down, or a transient RPC failure).
 * processSettle (workers/index.ts) is fully idempotent.
 */
export async function scheduleSettleJob(): Promise<void> {
  await settleQueue.add(
    'settle-tick',
    {},
    {
      repeat: { every: 60_000 }, // every minute
      jobId: 'settle-repeatable',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}

/**
 * Repeatable: mint invoices for subscriptions whose next cycle is due.
 *
 * Every minute, like the other ticks — a subscription is due on a date, so the
 * cost of checking often is nil and the benefit is that "bill on the 1st" means
 * the 1st rather than "some time on the 1st".
 *
 * This job firing TWICE is expected, not exceptional: BullMQ replays on retry,
 * and two workers may both hold a repeatable. Double-billing is prevented by a
 * unique index on (subscription_id, cycle_number), not by this schedule — see
 * services/subscriptionService.ts.
 */
export async function scheduleSubscriptionJob(): Promise<void> {
  await subscriptionQueue.add(
    'subscription-tick',
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'subscription-repeatable',
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}
