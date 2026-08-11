/**
 * Invoices — line items, a hosted pay page, and paid/unpaid tracking.
 *
 * ============================ AN INVOICE IS A FIAT OBLIGATION ================
 * An invoice says "you owe ₹5,000". It does NOT say "you owe 52.58 USDT". The
 * crypto amount is worked out when the customer actually pays, which is the
 * same rule the rest of the system follows: the quote locks at PAYMENT
 * creation, never earlier.
 *
 * That matters because an invoice lives in an inbox. Fixing the crypto amount
 * at issue time would mean a document sent on Monday is payable on Thursday at
 * Monday's price, and the merchant silently eats (or pockets) three days of
 * drift on every invoice anyone is slow to pay.
 *
 * ============================ ONE CAPABILITY, NOT TWO ========================
 * An invoice mints NO public token of its own. It owns a single-use
 * `payment_links` row, and that link's token is the only thing a customer ever
 * holds. Everything already true of a checkout link is therefore true here
 * without being re-derived: the rate limiters, the row-locked single-use claim,
 * and the reviewed public response shape.
 *
 * The public read added here (`getPublicInvoice`) is governed by the same rule
 * as `PublicLink`: `PublicInvoice` below is the complete list of what leaves the
 * building, and adding a field to it publishes that field to anyone who was
 * ever sent the URL. It carries the document — who it is from, what is on it,
 * what is owed — and nothing about the merchant beyond their business name.
 *
 * ============================ TOTALS ARE STORED, NOT DERIVED =================
 * `subtotal`/`total` and each item's `amount` are computed once and written.
 * A historical invoice must not restate itself because rounding conventions
 * changed, and a customer who paid must be able to see the document they paid.
 */
import { PoolClient } from 'pg';
import { ulid } from 'ulid';
import { query, queryOne, withTransaction } from '../db/pool';
import { AppError } from '../utils/apiError';
import { logger } from '../config/logger';
import { config } from '../config/env';
import { randomToken } from '../utils/crypto';
import { Network, parseNetwork } from '../blockchain/networks';
import { assetFor, enabledAssets } from '../blockchain/assets';
import { parseFiat } from './rateService';
import { sendInvoiceEmail } from './emailService';
import { enqueueWebhook } from './webhookService';

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/**
 * Fiat line-item arithmetic, in integer minor-ish units.
 *
 * Fiat totals are rounded to 2 dp — the precision the currency actually has —
 * using BigInt so `0.1 + 0.2` can never produce `0.30000000000000004` on a
 * document someone is expected to pay. This is deliberately NOT the 18-dp
 * ledger scale in utils/money.ts: that scale exists for crypto balances, and an
 * invoice is not a balance.
 */
const FIAT_DECIMALS = 2;
const FIAT_SCALE = 10n ** BigInt(FIAT_DECIMALS);
/** Quantities may be fractional (2.5 hours); kept at 6 dp internally. */
const QTY_DECIMALS = 6;
const QTY_SCALE = 10n ** BigInt(QTY_DECIMALS);

function toScaled(value: string | number, decimals: number): bigint {
  const s = String(value).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw AppError.badRequest(`"${value}" is not a valid number`);
  }
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

function fromScaled(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const div = 10n ** BigInt(decimals);
  const whole = abs / div;
  const frac = (abs % div).toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * quantity × unit_price, rounded HALF-UP to 2 dp.
 *
 * Half-up rather than the upward rounding used for crypto quotes: this is an
 * ordinary invoice line, not a conversion where one side is systematically
 * exposed. Both parties see the same arithmetic on the document.
 */
function lineAmount(quantity: string, unitPrice: string): string {
  const q = toScaled(quantity, QTY_DECIMALS);
  const p = toScaled(unitPrice, FIAT_DECIMALS);
  const product = q * p; // scaled by QTY_SCALE * FIAT_SCALE
  const half = QTY_SCALE / 2n;
  const rounded = (product + half) / QTY_SCALE; // back to FIAT_SCALE
  return fromScaled(rounded, FIAT_DECIMALS);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvoiceItemInput {
  description: string;
  quantity?: string;
  unitPrice: string;
}

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}

interface InvoiceRow {
  id: string;
  client_id: string;
  number: string;
  seq: string;
  customer_name: string | null;
  customer_email: string | null;
  currency: string;
  subtotal: string;
  tax_amount: string;
  total: string;
  notes: string | null;
  /**
   * A DATE column. node-postgres hands this back as a JS Date at LOCAL
   * midnight, NOT a string — always render it through `toDateOnly`, never via
   * toISOString, or the day shifts. See the note on that function.
   */
  due_date: string | null;
  status: string;
  payment_link_id: string | null;
  payment_id: string | null;
  asset: string | null;
  network: string | null;
  subscription_id: string | null;
  cycle_number: number | null;
  issued_at: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the MERCHANT sees. */
export interface Invoice {
  id: string;
  number: string;
  customerName: string | null;
  customerEmail: string | null;
  currency: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  dueDate: string | null;
  status: string;
  /** Derived, never stored — see the migration note. */
  overdue: boolean;
  asset: string | null;
  network: string | null;
  /** The shareable pay URL's token. Null while the invoice is a draft. */
  token: string | null;
  paymentId: string | null;
  subscriptionId: string | null;
  cycleNumber: number | null;
  issuedAt: string | null;
  sentAt: string | null;
  paidAt: string | null;
  createdAt: string;
  items: InvoiceItem[];
}

/**
 * What the PUBLIC sees at /pay/:token/invoice.
 *
 * Reviewed as a whole every time it changes. This is the DOCUMENT — the thing a
 * customer is entitled to read before paying — plus the business name so they
 * know who they are paying. It must never carry the merchant's id, email,
 * wallet, balance, webhook, other invoices, or this invoice's internal ids.
 */
export interface PublicInvoice {
  number: string;
  merchantName: string;
  customerName: string | null;
  currency: string;
  subtotal: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  dueDate: string | null;
  /** 'open' | 'paid' | 'void'. A draft is never reachable — it has no link. */
  status: string;
  overdue: boolean;
  issuedAt: string | null;
  items: Array<{ description: string; quantity: string; unitPrice: string; amount: string }>;
}

/**
 * Render a DATE column as a plain YYYY-MM-DD string.
 *
 * WHY NOT `new Date(v).toISOString().slice(0,10)`: node-postgres parses a DATE
 * into a JS Date at LOCAL midnight. Converting that to UTC moves it backwards
 * for every timezone east of Greenwich — an invoice saved as due on the 22nd
 * came back as due on the 21st on a machine in IST. A due date is a calendar
 * day with no timezone at all, so it must never make the round trip through an
 * instant.
 */
function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const d = value as Date;
  if (Number.isNaN(d.getTime?.())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today as a calendar day, in the same frame of reference as a due date. */
function todayString(): string {
  return toDateOnly(new Date())!;
}

/**
 * Overdue is DERIVED, never stored (see migration 011).
 *
 * Compared as calendar days rather than instants: an invoice due today is not
 * overdue until tomorrow, wherever the server happens to be.
 */
function isOverdue(row: InvoiceRow): boolean {
  if (row.status !== 'open') return false;
  const due = toDateOnly(row.due_date);
  if (!due) return false;
  return due < todayString();
}

function toInvoice(row: InvoiceRow, items: InvoiceItem[], token: string | null): Invoice {
  return {
    id: row.id,
    number: row.number,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    currency: row.currency,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    total: row.total,
    notes: row.notes,
    dueDate: toDateOnly(row.due_date),
    status: row.status,
    overdue: isOverdue(row),
    asset: row.asset,
    network: row.network,
    token,
    paymentId: row.payment_id,
    subscriptionId: row.subscription_id,
    cycleNumber: row.cycle_number,
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    items,
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateInvoiceInput {
  clientId: string;
  currency: string;
  items: InvoiceItemInput[];
  customerName?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
  /** ISO date (YYYY-MM-DD). */
  dueDate?: string | null;
  taxAmount?: string | null;
  /** Pin the settlement asset, or leave null to let the customer choose. */
  asset?: string | null;
  network?: string | null;
  /**
   * Issue immediately (mint the pay link) rather than saving a draft. A
   * subscription always issues; a human may want to look first.
   */
  issue?: boolean;
  /** Recurring provenance. Both or neither — the CHECK enforces it. */
  subscriptionId?: string | null;
  cycleNumber?: number | null;
  /** Join a transaction the caller owns (the subscription tick does). */
  tx?: PoolClient;
}

/**
 * Allocate this merchant's next invoice number.
 *
 * UPSERT-then-UPDATE-RETURNING inside the caller's transaction: the row lock
 * serialises concurrent creates, so two invoices cannot take the same number.
 * `MAX(seq)+1` would race, and a global sequence would leak one merchant's
 * volume to another.
 */
async function nextInvoiceNumber(
  tx: PoolClient,
  clientId: string,
): Promise<{ seq: number; number: string }> {
  await tx.query(
    `INSERT INTO invoice_counters (client_id, next_seq) VALUES ($1, 1)
     ON CONFLICT (client_id) DO NOTHING`,
    [clientId],
  );
  const res = await tx.query<{ next_seq: string }>(
    `UPDATE invoice_counters SET next_seq = next_seq + 1
      WHERE client_id = $1
      RETURNING next_seq - 1 AS next_seq`,
    [clientId],
  );
  const seq = Number(res.rows[0].next_seq);
  return { seq, number: `INV-${String(seq).padStart(4, '0')}` };
}

export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const currency = parseFiat(input.currency);

  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw AppError.badRequest('An invoice needs at least one line item');
  }
  if (input.items.length > 100) {
    throw AppError.badRequest('An invoice may have at most 100 line items');
  }

  // Validate the asset pin NOW rather than when the customer opens the link —
  // an invoice pinned to something this gateway cannot settle would otherwise
  // look fine in the dashboard and fail in front of the customer.
  let network: Network | null = null;
  let asset: string | null = null;
  if (input.network) network = parseNetwork(input.network);
  if (input.asset) {
    if (!network) {
      throw AppError.badRequest('Pinning an asset also requires pinning a network');
    }
    asset = assetFor(network, input.asset).symbol;
  }

  // ---- Totals, computed once ----
  const priced = input.items.map((item, i) => {
    const description = String(item.description ?? '').trim();
    if (!description) {
      throw AppError.badRequest(`Line ${i + 1} needs a description`);
    }
    const quantity = String(item.quantity ?? '1');
    const unitPrice = String(item.unitPrice ?? '');
    if (toScaled(quantity, QTY_DECIMALS) <= 0n) {
      throw AppError.badRequest(`Line ${i + 1}: quantity must be greater than zero`);
    }
    if (toScaled(unitPrice, FIAT_DECIMALS) < 0n) {
      throw AppError.badRequest(`Line ${i + 1}: unit price cannot be negative`);
    }
    return {
      description: description.slice(0, 500),
      quantity,
      unitPrice,
      amount: lineAmount(quantity, unitPrice),
    };
  });

  const subtotalScaled = priced.reduce(
    (acc, l) => acc + toScaled(l.amount, FIAT_DECIMALS),
    0n,
  );
  const taxScaled = input.taxAmount ? toScaled(input.taxAmount, FIAT_DECIMALS) : 0n;
  if (taxScaled < 0n) throw AppError.badRequest('Tax cannot be negative');
  const totalScaled = subtotalScaled + taxScaled;
  if (totalScaled <= 0n) {
    throw AppError.badRequest('An invoice total must be greater than zero');
  }

  const subtotal = fromScaled(subtotalScaled, FIAT_DECIMALS);
  const taxAmount = fromScaled(taxScaled, FIAT_DECIMALS);
  const total = fromScaled(totalScaled, FIAT_DECIMALS);

  const invoiceId = `inv_${ulid()}`;
  const shouldIssue = input.issue !== false;

  const body = async (tx: PoolClient) => {
    const { seq, number } = await nextInvoiceNumber(tx, input.clientId);

    // Mint the pay link at issue time. Single use and non-reusable: an invoice
    // is one demand to one customer, so a second payment against it would be an
    // overpayment nobody asked for.
    let linkId: string | null = null;
    let token: string | null = null;
    if (shouldIssue) {
      const link = await tx.query<{ id: string; token: string }>(
        `INSERT INTO payment_links
           (client_id, token, title, description, fiat_currency, fiat_amount,
            asset, network, reusable, max_uses)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, 1)
         RETURNING id, token`,
        [
          input.clientId,
          randomToken(24),
          number,
          input.customerName ? `Invoice for ${input.customerName}` : null,
          currency,
          total,
          asset,
          network,
        ],
      );
      linkId = link.rows[0].id;
      token = link.rows[0].token;
    }

    const inserted = await tx.query<InvoiceRow>(
      `INSERT INTO invoices
         (id, client_id, number, seq, customer_name, customer_email, currency,
          subtotal, tax_amount, total, notes, due_date, status, payment_link_id,
          asset, network, subscription_id, cycle_number, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        invoiceId,
        input.clientId,
        number,
        seq,
        input.customerName?.trim() || null,
        input.customerEmail?.trim().toLowerCase() || null,
        currency,
        subtotal,
        taxAmount,
        total,
        input.notes?.trim() || null,
        input.dueDate || null,
        shouldIssue ? 'open' : 'draft',
        linkId,
        asset,
        network,
        input.subscriptionId ?? null,
        input.cycleNumber ?? null,
        shouldIssue ? new Date().toISOString() : null,
      ],
    );

    const items: InvoiceItem[] = [];
    for (let i = 0; i < priced.length; i++) {
      const l = priced[i];
      const row = await tx.query<{ id: string }>(
        `INSERT INTO invoice_items
           (invoice_id, description, quantity, unit_price, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [invoiceId, l.description, l.quantity, l.unitPrice, l.amount, i],
      );
      items.push({ id: row.rows[0].id, ...l });
    }

    return toInvoice(inserted.rows[0], items, token);
  };

  return input.tx ? body(input.tx) : withTransaction(body);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * `tx` is not optional decoration. voidInvoice calls this from INSIDE its own
 * transaction, and going to the pool there makes the request hold one
 * connection while waiting for a second — with DB_POOL_MAX concurrent voids in
 * a process, every connection is held by a transaction waiting on a connection
 * only it can release, and they all fail at connectionTimeoutMillis (2s since
 * db/pool.ts was retuned, so it surfaces sooner than it used to). Read-only, so
 * borrowing the caller's connection changes nothing else: same rows, same
 * order, and a failure aborts a transaction that was about to be rolled back by
 * the same error anyway.
 */
async function loadItems(invoiceId: string, tx?: PoolClient): Promise<InvoiceItem[]> {
  const sql = `SELECT id, description, quantity, unit_price, amount
       FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, created_at`;
  type ItemRow = {
    id: string;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
  };
  const rows = tx
    ? (await tx.query<ItemRow>(sql, [invoiceId])).rows
    : await query<ItemRow>(sql, [invoiceId]);
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    quantity: r.quantity,
    unitPrice: r.unit_price,
    amount: r.amount,
  }));
}

interface InvoiceRowWithToken extends InvoiceRow {
  token: string | null;
}

export async function listInvoices(
  clientId: string,
  opts: { status?: string; limit?: number } = {},
): Promise<Invoice[]> {
  const args: unknown[] = [clientId];
  let where = 'i.client_id = $1';
  if (opts.status) {
    args.push(opts.status);
    where += ` AND i.status = $${args.length}`;
  }
  args.push(Math.min(200, Math.max(1, opts.limit ?? 100)));

  const rows = await query<InvoiceRowWithToken>(
    `SELECT i.*, l.token
       FROM invoices i
       LEFT JOIN payment_links l ON l.id = i.payment_link_id
      WHERE ${where}
      ORDER BY i.seq DESC
      LIMIT $${args.length}`,
    args,
  );
  // Items are omitted from the list view on purpose: the table shows number,
  // customer, total and status, and loading every line of every invoice to
  // render none of them is a query per row for nothing.
  return rows.map((r) => toInvoice(r, [], r.token));
}

export async function getInvoice(clientId: string, id: string): Promise<Invoice> {
  const row = await queryOne<InvoiceRowWithToken>(
    `SELECT i.*, l.token
       FROM invoices i
       LEFT JOIN payment_links l ON l.id = i.payment_link_id
      WHERE i.id = $1 AND i.client_id = $2`,
    [id, clientId],
  );
  if (!row) throw AppError.notFound('Invoice not found');
  return toInvoice(row, await loadItems(row.id), row.token);
}

/**
 * The PUBLIC document, resolved by the pay link's token.
 *
 * Scoped by token for the same reason as `getPublicPayment`: the token is what
 * the customer legitimately holds, so a leaked invoice id alone reveals
 * nothing. A draft has no link and is therefore unreachable here, which is what
 * "draft" is supposed to mean.
 */
export async function getPublicInvoice(token: string): Promise<PublicInvoice> {
  const row = await queryOne<InvoiceRow & { business_name: string; client_status: string }>(
    `SELECT i.*, c.business_name, c.status::text AS client_status
       FROM invoices i
       JOIN payment_links l ON l.id = i.payment_link_id
       JOIN clients c ON c.id = i.client_id
      WHERE l.token = $1`,
    [token],
  );
  // A suspended merchant's invoices stop resolving, reported as a plain 404 —
  // the same treatment (and for the same reason) as their payment links.
  if (!row || row.client_status !== 'approved') {
    throw AppError.notFound('No invoice found for this link.');
  }

  const items = await loadItems(row.id);
  return {
    number: row.number,
    merchantName: row.business_name,
    customerName: row.customer_name,
    currency: row.currency,
    subtotal: row.subtotal,
    taxAmount: row.tax_amount,
    total: row.total,
    notes: row.notes,
    dueDate: toDateOnly(row.due_date),
    status: row.status,
    overdue: isOverdue(row),
    issuedAt: row.issued_at ? new Date(row.issued_at).toISOString() : null,
    items: items.map((i) => ({
      description: i.description,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      amount: i.amount,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** The shareable pay URL for an invoice token. */
export function invoiceUrl(token: string): string {
  return `${config.signup.panelUrl}/pay/${token}`;
}

/**
 * Void an invoice and disable its pay link in the same transaction.
 *
 * Both halves matter: an invoice marked void whose link still works is a
 * withdrawn demand a customer can still pay, and the money would arrive against
 * a document the merchant considers cancelled.
 *
 * A PAID invoice cannot be voided — the money has already moved, and pretending
 * otherwise would put the ledger and the document into permanent disagreement.
 *
 * ============================ A CHECKOUT ALREADY OPEN IS NOT "FUTURE" ========
 * Disabling the link only stops the NEXT customer: it is consulted when a use is
 * claimed, and never again. A payment already created from this link keeps its
 * deposit address in every listener's watch set and runs its whole lifecycle to
 * confirmed and swept — after which the money counts toward the merchant's
 * withdrawable balance while the invoice sits at 'void' forever, matched by no
 * reconciliation and reported by no log line. So the payments are dealt with
 * here, explicitly, in one of two ways:
 *
 *   - FUNDS HAVE ARRIVED (amount_received > 0): refuse the void, naming the
 *     payment. The merchant is asking to withdraw a demand that is in the middle
 *     of being met; there is no refund path in this system, so the only honest
 *     answer is to say so rather than to void and let the money land anyway.
 *
 *   - NOTHING HAS ARRIVED: void, and expire those payments in the same
 *     transaction. That is the same terminal state processExpiry would give them
 *     minutes later, reached deliberately: the address leaves the watch set with
 *     the demand it belonged to, and the customer's checkout stops showing an
 *     address for an invoice that no longer exists.
 *
 * ORDERING IS LOAD-BEARING. The link is disabled BEFORE the payments are read.
 * That UPDATE takes the same row lock claimLinkUse holds while it creates a
 * payment, so a checkout racing this void either commits first and is seen by
 * the read below, or waits and then finds the link disabled. Reading first would
 * leave a window in which a brand-new payment is missed entirely.
 */
export async function voidInvoice(clientId: string, id: string): Promise<Invoice> {
  const expired: string[] = [];
  const invoice = await withTransaction(async (tx) => {
    const current = await tx.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE id = $1 AND client_id = $2 FOR UPDATE`,
      [id, clientId],
    );
    const row = current.rows[0];
    if (!row) throw AppError.notFound('Invoice not found');
    if (row.status === 'paid') {
      throw AppError.badRequest(
        'This invoice has already been paid and cannot be voided. Refund it out of band if needed.',
      );
    }
    if (row.status === 'void') {
      return toInvoice(row, await loadItems(row.id, tx), null);
    }

    if (row.payment_link_id) {
      await tx.query(
        `UPDATE payment_links SET status = 'disabled', updated_at = now() WHERE id = $1`,
        [row.payment_link_id],
      );

      // `funded` is evaluated in NUMERIC, in the database. An 18-decimal amount
      // must never make the trip through a JS number to be compared with zero.
      //
      // FOR UPDATE, because this read is a money decision. Under READ COMMITTED
      // a plain SELECT takes its snapshot at statement start, so a listener
      // crediting one of these payments mid-statement is invisible to it: the
      // 409 below would not fire, the expiry UPDATE (which re-reads under its
      // own lock) would then decline to match the now-funded row, and the
      // invoice would be voided with live money against it — exactly the hole
      // this block exists to close. Locking makes the read see the committed
      // credit and refuse. It adds no blocking exposure that was not already
      // there: the expiry UPDATE three statements down takes the same row locks.
      const live = await tx.query<{ id: string; funded: boolean }>(
        `SELECT id, (amount_received > 0) AS funded
           FROM payments
          WHERE payment_link_id = $1
            AND status IN ('waiting','confirming','partial')
          FOR UPDATE`,
        [row.payment_link_id],
      );

      const funded = live.rows.filter((p) => p.funded);
      if (funded.length > 0) {
        throw AppError.conflict(
          funded.length > 1
            ? `${funded.length} payments are already in flight against this invoice ` +
              `(including ${funded[0].id}). It cannot be voided while funds are ` +
              'arriving — let them settle, or resolve them out of band first.'
            : `Payment ${funded[0].id} is already in flight against this invoice and ` +
              'funds have arrived. It cannot be voided — let it settle, or resolve ' +
              'that payment out of band first.',
        );
      }

      // Only 'waiting' with nothing received. A 'confirming' or 'partial' row
      // reached that state by recording a transfer, so it is funded by
      // construction and was refused above; restricting the predicate means this
      // statement can never touch a payment whose money is being tracked.
      const closed = await tx.query<{ id: string }>(
        `UPDATE payments SET status = 'expired'
          WHERE payment_link_id = $1
            AND status = 'waiting'
            AND amount_received = 0
          RETURNING id`,
        [row.payment_link_id],
      );
      expired.push(...closed.rows.map((p) => p.id));
    }

    const updated = await tx.query<InvoiceRow>(
      `UPDATE invoices SET status = 'void' WHERE id = $1 RETURNING *`,
      [id],
    );
    return toInvoice(updated.rows[0], await loadItems(id, tx), null);
  });

  // AFTER the commit, for two reasons: enqueueWebhook reads the payment back on
  // a pooled connection and would otherwise see the pre-void status, and a
  // rolled-back void must not leave a merchant told their payment expired.
  // Same event processExpiry emits for the same transition, so no integration
  // sees a state change it has no vocabulary for.
  for (const paymentId of expired) {
    logger.info({ invoiceId: id, paymentId }, 'invoice voided; unfunded checkout expired with it');
    enqueueWebhook({ paymentId, event: 'payment.expired' }).catch((err) =>
      logger.warn({ err, paymentId }, 'payment.expired webhook enqueue failed'),
    );
  }
  return invoice;
}

/**
 * Email an invoice to its customer.
 *
 * Returns whether the mail was actually handed to a transport. In development
 * (no SMTP) the rendered message goes to the log instead and this is false —
 * `sent_at` is still stamped, because the merchant did perform the send and the
 * absence of a mail server is not their action to see.
 */
export async function sendInvoice(clientId: string, id: string): Promise<{ sent: boolean; to: string }> {
  const invoice = await getInvoice(clientId, id);
  if (invoice.status === 'draft' || !invoice.token) {
    throw AppError.badRequest(
      'This invoice is still a draft. Issue it first — a draft has no pay link to send.',
    );
  }
  if (invoice.status === 'void') {
    throw AppError.badRequest('This invoice has been voided and cannot be sent.');
  }
  if (!invoice.customerEmail) {
    throw AppError.badRequest('Add a customer email address before sending.');
  }

  const client = await queryOne<{ business_name: string }>(
    `SELECT business_name FROM clients WHERE id = $1`,
    [clientId],
  );

  const sent = await sendInvoiceEmail({
    to: invoice.customerEmail,
    merchantName: client?.business_name ?? 'a merchant',
    number: invoice.number,
    customerName: invoice.customerName,
    currency: invoice.currency,
    total: invoice.total,
    dueDate: invoice.dueDate,
    payUrl: invoiceUrl(invoice.token),
    items: invoice.items.map((i) => ({ description: i.description, amount: i.amount })),
  });

  await query(`UPDATE invoices SET sent_at = now() WHERE id = $1`, [id]);
  return { sent, to: invoice.customerEmail };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Mark invoices paid whose payment has actually settled.
 *
 * Runs on the settle tick rather than being fired from the listener, for the
 * same reason `processSettle` exists at all: a status change that depends on a
 * single in-process event is lost the one time that process is restarting. This
 * is a sweep over reality, so it is correct whether or not any particular event
 * was delivered.
 *
 * Idempotent by construction — the WHERE clause only ever matches an invoice
 * that is still open, so a second pass updates nothing and fires nothing.
 *
 * 'swept' is included alongside 'confirmed' because a fast sweep can move a
 * payment past 'confirmed' between two ticks; excluding it would leave those
 * invoices unpaid forever.
 *
 * ============================ THE AMOUNT IS CHECKED, NOT ASSUMED =============
 * `amount_received >= amount` is deliberately restated here even though the
 * listeners now hold a short payment at 'partial' and never promote it to
 * 'confirmed'. This statement turns a chain status into a merchant-facing
 * accounting fact and an invoice.paid webhook, and it is edited by different
 * people at different times from the listeners — so it states its own
 * precondition rather than inheriting one.
 *
 * It cannot strand a genuinely paid invoice: promotion requires the sum of
 * transfers that have INDIVIDUALLY cleared their confirmations to reach
 * `amount`, and `amount_received` is that same sum plus anything still pending,
 * so it is >= it by construction. A payment that fails this predicate was never
 * promotable in the first place, and it stays at 'partial' where the customer
 * can still top it up — after which the next tick marks the invoice paid.
 */
export async function reconcilePaidInvoices(): Promise<number> {
  const rows = await query<{ id: string; payment_id: string; client_id: string }>(
    `UPDATE invoices i
        SET status = 'paid',
            paid_at = COALESCE(p.confirmed_at, now()),
            payment_id = p.id
       FROM payments p
       JOIN payment_links l ON l.id = p.payment_link_id
      WHERE l.id = i.payment_link_id
        AND i.status = 'open'
        AND p.status IN ('confirmed','swept')
        AND p.amount_received >= p.amount
      RETURNING i.id, p.id AS payment_id, i.client_id`,
  );

  for (const r of rows) {
    logger.info({ invoiceId: r.id, paymentId: r.payment_id }, 'invoice marked paid');
    // Reuses the payment-scoped webhook path: the event is about an invoice,
    // but it is carried by the payment that settled it, so no new delivery
    // machinery or signing scheme is introduced.
    enqueueWebhook({ paymentId: r.payment_id, event: 'invoice.paid' }).catch((err) =>
      logger.warn({ err, invoiceId: r.id }, 'invoice.paid webhook enqueue failed'),
    );
  }
  return rows.length;
}

/** Fiat currencies plus the assets a merchant may pin — drives the invoice form. */
export function invoiceOptions(): {
  assets: Array<{ symbol: string; network: string; name: string }>;
} {
  return {
    assets: enabledAssets().map((a) => ({
      symbol: a.symbol,
      network: a.network,
      name: a.name,
    })),
  };
}
