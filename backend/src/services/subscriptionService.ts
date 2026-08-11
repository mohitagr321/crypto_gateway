/**
 * Recurring billing — subscriptions that mint one invoice per cycle.
 *
 * A subscription is a schedule, not a charge. Nothing here debits anyone: each
 * cycle produces an INVOICE with its own pay link, which the customer settles
 * the same way they would settle any other. That is the only honest model for a
 * crypto gateway — there is no stored mandate to pull from, and inventing the
 * appearance of one would be worse than not having it.
 *
 * ============================ THREE RULES DO THE WORK ========================
 *
 * 1. THE DATABASE PREVENTS DOUBLE-BILLING, NOT THIS CODE.
 *    `uq_invoices_subscription_cycle` makes (subscription, cycle) unique. The
 *    tick is a repeatable job, and repeatable jobs fire twice — a worker
 *    restarts mid-run, two workers race, BullMQ replays a retry. When that
 *    happens the second insert raises 23505 and is caught below as "already
 *    billed". Correctness does not depend on the worker being careful, because
 *    over enough restarts it won't be.
 *
 * 2. BILLING DATES DO NOT DRIFT.
 *    `next_run_at` advances by exactly one interval from ITS OWN previous
 *    value, never from now(). A worker down for six hours bills late once and
 *    then resumes the original schedule; advancing from now() would push every
 *    future cycle six hours later, permanently, and a monthly plan would walk
 *    its way through the calendar.
 *
 * 3. A BACKLOG IS PARKED, NOT FLUSHED.
 *    At most one invoice per subscription per tick. A subscription that has
 *    fallen more than `max_cycles_behind` behind stops and goes to
 *    'needs_attention' instead of firing a burst of invoices into a customer's
 *    inbox for months nobody billed at the time. Neither silently skipping the
 *    revenue nor machine-gunning the customer is a decision this code should
 *    make on its own — so it makes neither, and asks for a human.
 */
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/pool';
import { AppError } from '../utils/apiError';
import { logger } from '../config/logger';
import { Network, parseNetwork } from '../blockchain/networks';
import { assetFor } from '../blockchain/assets';
import { parseFiat } from './rateService';
import { createInvoice, sendInvoice } from './invoiceService';

export const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

/** How many due subscriptions one tick will process. */
const TICK_BATCH_LIMIT = 200;

interface SubscriptionRow {
  id: string;
  client_id: string;
  title: string;
  description: string | null;
  customer_name: string | null;
  customer_email: string | null;
  currency: string;
  amount: string;
  asset: string | null;
  network: string | null;
  interval_unit: string;
  interval_count: number;
  status: string;
  next_run_at: string;
  total_cycles: number | null;
  cycles_billed: number;
  max_cycles_behind: number;
  due_days: number;
  auto_send: boolean;
  last_invoice_id: string | null;
  last_run_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Subscription {
  id: string;
  title: string;
  description: string | null;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  amount: string;
  asset: string | null;
  network: string | null;
  intervalUnit: string;
  intervalCount: number;
  status: string;
  nextRunAt: string;
  totalCycles: number | null;
  cyclesBilled: number;
  dueDays: number;
  autoSend: boolean;
  lastInvoiceId: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

function toSubscription(r: SubscriptionRow): Subscription {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    currency: r.currency,
    amount: r.amount,
    asset: r.asset,
    network: r.network,
    intervalUnit: r.interval_unit,
    intervalCount: r.interval_count,
    status: r.status,
    nextRunAt: new Date(r.next_run_at).toISOString(),
    totalCycles: r.total_cycles,
    cyclesBilled: r.cycles_billed,
    dueDays: r.due_days,
    autoSend: r.auto_send,
    lastInvoiceId: r.last_invoice_id,
    lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * The SQL interval literal for a subscription's cycle.
 *
 * Built from a validated unit and a bounded integer, never from raw input —
 * this string is concatenated into a cast, so anything less would be an
 * injection point. Postgres interval arithmetic is used rather than JS date
 * maths because it already handles the month-end cases correctly: 31 January
 * plus one month is 28 February, and getting that wrong bills someone on a day
 * that does not exist.
 */
function intervalLiteral(unit: string, count: number): string {
  if (!INTERVAL_UNITS.includes(unit as IntervalUnit)) {
    throw AppError.badRequest(`Unsupported interval: ${unit}`);
  }
  const n = Math.floor(Number(count));
  if (!Number.isInteger(n) || n < 1 || n > 366) {
    throw AppError.badRequest('intervalCount must be between 1 and 366');
  }
  return `${n} ${unit}`;
}

// ---------------------------------------------------------------------------
// Merchant operations
// ---------------------------------------------------------------------------

export interface CreateSubscriptionInput {
  clientId: string;
  title: string;
  amount: string;
  /**
   * Fiat code. Subscriptions bill by issuing invoices, and an invoice is a fiat
   * document — so a plan is priced in fiat and each cycle's crypto amount is
   * quoted when the customer pays it.
   */
  currency: string;
  intervalUnit: string;
  intervalCount?: number;
  description?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  asset?: string | null;
  network?: string | null;
  /** When the FIRST invoice should be minted. Defaults to now. */
  startAt?: string | null;
  totalCycles?: number | null;
  dueDays?: number;
  autoSend?: boolean;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<Subscription> {
  const currency = parseFiat(input.currency);
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest('amount must be a positive number');
  }
  // Validates the unit and count, and throws before anything is written.
  intervalLiteral(input.intervalUnit, input.intervalCount ?? 1);

  let network: Network | null = null;
  let asset: string | null = null;
  if (input.network) network = parseNetwork(input.network);
  if (input.asset) {
    if (!network) {
      throw AppError.badRequest('Pinning an asset also requires pinning a network');
    }
    asset = assetFor(network, input.asset).symbol;
  }

  const autoSend = input.autoSend ?? Boolean(input.customerEmail);
  if (autoSend && !input.customerEmail) {
    // Also a CHECK constraint. Caught here so the merchant gets a sentence
    // rather than a constraint name.
    throw AppError.badRequest(
      'Emailing each invoice needs a customer email address. Add one, or turn off auto-send.',
    );
  }

  // A start date in the past would make the subscription immediately overdue
  // and bill on the very next tick, which is surprising rather than useful —
  // and a start date far enough back that the plan is already more than
  // `max_cycles_behind` cycles late is parked straight into 'needs_attention'
  // by the first tick, having never billed anything at all.
  //
  // The check the comment above has always described is now actually made. The
  // tolerance is there for clock skew between a merchant's server and this one:
  // an integration that means "start now" and computes the timestamp itself
  // must not be rejected for being a few seconds slow.
  const START_AT_PAST_TOLERANCE_MS = 5 * 60_000;
  const startAt = input.startAt ? new Date(input.startAt) : new Date();
  if (Number.isNaN(startAt.getTime())) {
    throw AppError.badRequest('startAt must be a valid date');
  }
  if (startAt.getTime() < Date.now() - START_AT_PAST_TOLERANCE_MS) {
    throw AppError.badRequest(
      'startAt cannot be in the past — the first invoice would be issued ' +
        'immediately. Use a future date, or omit it to start now.',
    );
  }

  const row = await queryOne<SubscriptionRow>(
    `INSERT INTO subscriptions
       (client_id, title, description, customer_name, customer_email, currency,
        amount, asset, network, interval_unit, interval_count, next_run_at,
        total_cycles, due_days, auto_send)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      input.clientId,
      input.title.trim(),
      input.description?.trim() || null,
      input.customerName?.trim() || null,
      input.customerEmail?.trim().toLowerCase() || null,
      currency,
      input.amount,
      asset,
      network,
      input.intervalUnit,
      input.intervalCount ?? 1,
      startAt.toISOString(),
      input.totalCycles ?? null,
      input.dueDays ?? 7,
      autoSend,
    ],
  );
  if (!row) throw AppError.internal('failed to create subscription');
  return toSubscription(row);
}

export async function listSubscriptions(clientId: string): Promise<Subscription[]> {
  const rows = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE client_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [clientId],
  );
  return rows.map(toSubscription);
}

export async function getSubscription(
  clientId: string,
  id: string,
): Promise<Subscription> {
  const row = await queryOne<SubscriptionRow>(
    `SELECT * FROM subscriptions WHERE id = $1 AND client_id = $2`,
    [id, clientId],
  );
  if (!row) throw AppError.notFound('Subscription not found');
  return toSubscription(row);
}

/**
 * Pause, resume, or cancel.
 *
 * RESUMING DOES NOT BACK-BILL. `next_run_at` is pushed forward to the next
 * boundary at or after now, so a plan paused for two months does not fire two
 * months of invoices the moment it comes back. A pause is a decision not to
 * bill for that time; treating it as deferred billing would reverse the
 * merchant's intent at the worst possible moment.
 *
 * Cancelling is terminal — a cancelled subscription is never reactivated, only
 * replaced. That keeps `cycles_billed` and the invoice history meaning one
 * unambiguous thing.
 */
export async function setSubscriptionStatus(
  clientId: string,
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<Subscription> {
  return withTransaction(async (tx) => {
    const res = await tx.query<SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE id = $1 AND client_id = $2 FOR UPDATE`,
      [id, clientId],
    );
    const row = res.rows[0];
    if (!row) throw AppError.notFound('Subscription not found');
    if (row.status === 'canceled') {
      throw AppError.badRequest(
        'This subscription has been cancelled. Create a new one to start billing again.',
      );
    }

    if (action === 'cancel') {
      const updated = await tx.query<SubscriptionRow>(
        `UPDATE subscriptions SET status = 'canceled', canceled_at = now()
          WHERE id = $1 RETURNING *`,
        [id],
      );
      return toSubscription(updated.rows[0]);
    }

    if (action === 'pause') {
      const updated = await tx.query<SubscriptionRow>(
        `UPDATE subscriptions SET status = 'paused' WHERE id = $1 RETURNING *`,
        [id],
      );
      return toSubscription(updated.rows[0]);
    }

    // resume — also the way out of 'needs_attention', which is the whole point
    // of that state: a human looks, then restarts it on a clean schedule.
    const iv = intervalLiteral(row.interval_unit, row.interval_count);
    const updated = await tx.query<SubscriptionRow>(
      // Walk next_run_at forward in whole intervals until it is in the future.
      // Whole intervals rather than "now + one interval" so a monthly plan
      // resumed mid-month keeps billing on its original day of the month.
      `UPDATE subscriptions
          SET status = 'active',
              next_run_at = (
                SELECT CASE
                  WHEN next_run_at > now() THEN next_run_at
                  ELSE next_run_at + $2::interval *
                       (floor(EXTRACT(EPOCH FROM (now() - next_run_at)) /
                              NULLIF(EXTRACT(EPOCH FROM $2::interval), 0))::int + 1)
                END
              )
        WHERE id = $1
        RETURNING *`,
      [id, iv],
    );
    return toSubscription(updated.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// The billing tick
// ---------------------------------------------------------------------------

interface BilledInvoice {
  clientId: string;
  invoiceId: string;
  subscriptionId: string;
  autoSend: boolean;
}

/**
 * Bill one subscription, holding its row lock for the whole decision.
 *
 * Returns null when there was nothing to do — not due any more, already
 * cancelled, or another worker got there first. Callers treat null as normal.
 */
async function billOne(subscriptionId: string): Promise<BilledInvoice | null> {
  return withTransaction(async (tx: PoolClient) => {
    // Re-read under the lock. Everything checked before this point is a
    // suggestion; only what is true while the row is locked can be acted on.
    const res = await tx.query<SubscriptionRow>(
      `SELECT * FROM subscriptions
        WHERE id = $1 AND status = 'active' AND next_run_at <= now()
        FOR UPDATE`,
      [subscriptionId],
    );
    const sub = res.rows[0];
    if (!sub) return null;

    const iv = intervalLiteral(sub.interval_unit, sub.interval_count);

    // ---- Rule 3: too far behind to catch up safely? ----
    const behind = await tx.query<{ too_far: boolean }>(
      `SELECT (($1::timestamptz + $2::interval * ($3::int + 1)) <= now()) AS too_far`,
      [sub.next_run_at, iv, sub.max_cycles_behind],
    );
    if (behind.rows[0]?.too_far) {
      await tx.query(
        `UPDATE subscriptions SET status = 'needs_attention' WHERE id = $1`,
        [subscriptionId],
      );
      logger.warn(
        {
          subscriptionId,
          nextRunAt: sub.next_run_at,
          maxCyclesBehind: sub.max_cycles_behind,
        },
        'subscription is too far behind schedule; parked as needs_attention ' +
          'instead of emitting a backlog of invoices',
      );
      return null;
    }

    const cycleNumber = sub.cycles_billed + 1;
    const dueDate = await dueDateFor(tx, sub.due_days);

    // ---- Mint the invoice for this cycle ----
    //
    // Wrapped in a SAVEPOINT because the duplicate case below is EXPECTED, and
    // in Postgres a failed statement poisons the whole transaction: every
    // command after it errors with "current transaction is aborted" until a
    // rollback. Without the savepoint the recovery path cannot run its own
    // UPDATE, so the schedule never advances and the tick retries the same
    // collision every minute, forever.
    //
    // Rolling back to the savepoint also discards the payment_links row
    // createInvoice inserted before the collision — otherwise each replay would
    // leak an orphaned link.
    let invoiceId: string | null = null;
    await tx.query('SAVEPOINT bill_cycle');
    try {
      const invoice = await createInvoice({
        tx,
        clientId: sub.client_id,
        currency: sub.currency,
        customerName: sub.customer_name,
        customerEmail: sub.customer_email,
        asset: sub.asset,
        network: sub.network,
        subscriptionId: sub.id,
        cycleNumber,
        issue: true,
        dueDate,
        items: [
          {
            description: sub.description
              ? `${sub.title} — ${sub.description}`
              : `${sub.title} (cycle ${cycleNumber})`,
            quantity: '1',
            unitPrice: sub.amount,
          },
        ],
      });
      invoiceId = invoice.id;
      await tx.query('RELEASE SAVEPOINT bill_cycle');
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT bill_cycle');
      // ---- Rule 1: the unique index caught a replay ----
      if ((err as { code?: string })?.code !== '23505') throw err;
      // This cycle was already billed by another run. Advance anyway, so the
      // schedule moves on instead of retrying the same collision forever.
      logger.info(
        { subscriptionId, cycleNumber },
        'subscription cycle already billed; advancing without a duplicate invoice',
      );
      await advance(tx, subscriptionId, iv, sub, cycleNumber, null);
      return null;
    }

    await advance(tx, subscriptionId, iv, sub, cycleNumber, invoiceId);

    return {
      clientId: sub.client_id,
      invoiceId,
      subscriptionId: sub.id,
      autoSend: sub.auto_send && Boolean(sub.customer_email),
    };
  });
}

/** The due date for an invoice issued now, using Postgres date arithmetic. */
async function dueDateFor(tx: PoolClient, dueDays: number): Promise<string> {
  const res = await tx.query<{ d: string }>(
    `SELECT to_char((now() + make_interval(days => $1))::date, 'YYYY-MM-DD') AS d`,
    [Math.max(0, Math.min(365, Math.floor(dueDays)))],
  );
  return res.rows[0].d;
}

/**
 * Move the schedule on by exactly one interval — Rule 2.
 *
 * Also closes the subscription when it has billed every cycle it was asked to.
 * That is a completion, not a cancellation by a merchant, but 'canceled' is the
 * terminal state the schema has and the distinction is carried by
 * `cycles_billed == total_cycles` rather than by inventing a fifth status.
 */
async function advance(
  tx: PoolClient,
  id: string,
  interval: string,
  sub: SubscriptionRow,
  cycleNumber: number,
  invoiceId: string | null,
): Promise<void> {
  const finished = sub.total_cycles !== null && cycleNumber >= sub.total_cycles;
  await tx.query(
    `UPDATE subscriptions
        SET next_run_at   = next_run_at + $2::interval,
            cycles_billed = $3,
            last_run_at   = now(),
            last_invoice_id = COALESCE($4, last_invoice_id),
            status        = CASE WHEN $5 THEN 'canceled' ELSE status END,
            canceled_at   = CASE WHEN $5 THEN now() ELSE canceled_at END
      WHERE id = $1`,
    [id, interval, cycleNumber, invoiceId, finished],
  );
  if (finished) {
    logger.info(
      { subscriptionId: id, cycles: cycleNumber },
      'subscription completed its final cycle',
    );
  }
}

/**
 * One pass of the billing tick. Idempotent and safe to run concurrently.
 *
 * Emails go out AFTER each transaction commits — sending inside it would mail a
 * customer an invoice that a later rollback erased, and there is no unsend.
 */
export async function runDueSubscriptions(): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT id FROM subscriptions
      WHERE status = 'active' AND next_run_at <= now()
      ORDER BY next_run_at ASC
      LIMIT $1`,
    [TICK_BATCH_LIMIT],
  );
  if (due.length === 0) return 0;

  let billed = 0;
  for (const { id } of due) {
    let result: BilledInvoice | null = null;
    try {
      result = await billOne(id);
    } catch (err) {
      // One bad subscription must not stop the run for everyone else.
      logger.error({ err, subscriptionId: id }, 'failed to bill subscription');
      continue;
    }
    if (!result) continue;
    billed++;

    if (result.autoSend) {
      try {
        await sendInvoice(result.clientId, result.invoiceId);
      } catch (err) {
        // The invoice EXISTS and is payable; only the email failed. Never
        // retried by re-billing — that would be how one outage becomes two
        // invoices for the same month.
        logger.warn(
          { err, invoiceId: result.invoiceId },
          'subscription invoice created but could not be emailed; it is still payable',
        );
      }
    }
  }

  if (billed > 0) {
    logger.info(
      { billed, considered: due.length, capped: due.length === TICK_BATCH_LIMIT },
      'subscription tick issued invoices',
    );
  }
  return billed;
}
