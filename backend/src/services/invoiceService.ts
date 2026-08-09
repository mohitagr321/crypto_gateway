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

async function loadItems(invoiceId: string): Promise<InvoiceItem[]> {
  const rows = await query<{
    id: string;
    description: string;
    quantity: string;
    unit_price: string;
    amount: string;
  }>(
    `SELECT id, description, quantity, unit_price, amount
       FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, created_at`,
    [invoiceId],
  );
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
 */
export async function voidInvoice(clientId: string, id: string): Promise<Invoice> {
  return withTransaction(async (tx) => {
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
      return toInvoice(row, await loadItems(row.id), null);
    }

    if (row.payment_link_id) {
      await tx.query(
        `UPDATE payment_links SET status = 'disabled', updated_at = now() WHERE id = $1`,
        [row.payment_link_id],
      );
    }
    const updated = await tx.query<InvoiceRow>(
      `UPDATE invoices SET status = 'void' WHERE id = $1 RETURNING *`,
      [id],
    );
    return toInvoice(updated.rows[0], await loadItems(id), null);
  });
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
