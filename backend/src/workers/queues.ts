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

// Standard retry policy for delivery/blockchain jobs.
export const defaultJobOptions: JobsOptions = {
  attempts: Math.max(1, config.webhook.maxRetries),
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

// BullMQ owns the producer connections (created from options).
const connection = bullConnectionOptions;

export const webhookQueue = new Queue(QUEUE_NAMES.webhook, {
  connection,
  defaultJobOptions,
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
