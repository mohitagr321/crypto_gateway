/**
 * Payment links — the hosted-checkout data layer.
 *
 * A link is a shareable URL a merchant sends to a customer. The customer opens
 * it, picks a coin, and pays. No integration, no API key, no code.
 *
 * ============================ THE TOKEN IS A CAPABILITY =======================
 * `token` travels in a URL that gets pasted into chats and emails. Anyone
 * holding it can open the checkout — that is the point. What matters is that it
 * grants EXACTLY that and nothing else:
 *
 *   - `toPublicLink` is the only shape the public API ever returns, and it
 *     carries the business name, the amount and the accepted assets. Never the
 *     merchant's id, email, wallet, balance, webhook or key material.
 *   - The public status endpoint is reachable only for payments that were
 *     created THROUGH a link, scoped to that link's token. A payment created
 *     via the API has `payment_link_id IS NULL` and stays private.
 *
 * ============================ SINGLE-USE MEANS SINGLE-USE =====================
 * `use_count` is incremented inside the same transaction that creates the
 * payment, under `SELECT … FOR UPDATE` on the link row. Two customers opening a
 * one-use link simultaneously therefore cannot both get a deposit address: the
 * second blocks on the row lock, re-reads the incremented count, and is refused.
 * Checking the count outside the transaction would let both through.
 */
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/pool';
import { AppError } from '../utils/apiError';
import { randomToken } from '../utils/crypto';
import { Network, parseNetwork, enabledNetworks } from '../blockchain/networks';
import { assetFor, enabledAssets } from '../blockchain/assets';
import { parseFiat } from './rateService';

export interface PaymentLinkRow {
  id: string;
  client_id: string;
  token: string;
  title: string;
  description: string | null;
  amount: string | null;
  /**
   * Fiat price, mutually exclusive with `amount`. When set, the crypto amount is
   * computed at PAYMENT creation rather than here — so an invoice sitting unpaid
   * in an inbox for days is settled at the price current when it is paid, not
   * when it was issued.
   */
  fiat_currency: string | null;
  fiat_amount: string | null;
  asset: string | null;
  network: string | null;
  reusable: boolean;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** What the MERCHANT sees (their own link, in their dashboard). */
export interface MerchantLink {
  id: string;
  token: string;
  title: string;
  description: string | null;
  amount: string | null;
  /** Set instead of `amount` on a fiat-priced link (every invoice link). */
  fiatAmount: string | null;
  fiatCurrency: string | null;
  asset: string | null;
  network: string | null;
  reusable: boolean;
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  status: string;
  createdAt: string;
}

/**
 * What the PUBLIC sees. Reviewed as a whole every time it changes: any field
 * added here is visible to anyone who has ever been sent the URL.
 */
export interface PublicLink {
  token: string;
  title: string;
  description: string | null;
  /** Business name only — the customer needs to know who they are paying. */
  merchantName: string;
  amount: string | null;
  /**
   * Fiat price, when the link is priced that way. Publishing it is safe and
   * necessary — it IS the price, which `amount` already exposes; the checkout
   * cannot show "₹5,000 due" without it.
   */
  fiatAmount: string | null;
  fiatCurrency: string | null;
  /** True when this link is the pay page for an invoice, so the customer is
   *  offered the document rather than a bare amount. Carries no invoice detail:
   *  that is fetched separately and shaped by `PublicInvoice`. */
  hasInvoice: boolean;
  /** Pinned asset/network, or null when the customer chooses. */
  asset: string | null;
  network: string | null;
  /**
   * What the customer may choose from, when nothing is pinned.
   *
   * `isNative` marks the chain's own coin. Published because the checkout has to
   * warn about it: there is no contract address to verify, and an exchange
   * withdrawal has to be sent over the matching network or it is lost. It says
   * nothing about the merchant.
   */
  options: Array<{
    symbol: string;
    network: string;
    name: string;
    isNative: boolean;
  }>;
  expiresAt: string | null;
  /** False once expired, disabled or used up — the page renders a dead end. */
  usable: boolean;
  unusableReason: string | null;
}

function toMerchantLink(r: PaymentLinkRow): MerchantLink {
  return {
    id: r.id,
    token: r.token,
    title: r.title,
    description: r.description,
    amount: r.amount,
    fiatAmount: r.fiat_amount,
    fiatCurrency: r.fiat_currency,
    asset: r.asset,
    network: r.network,
    reusable: r.reusable,
    maxUses: r.max_uses,
    useCount: r.use_count,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * Why a link cannot be paid, or null when it can. Returned to the public page so
 * it can say "this link has expired" instead of a bare 404 — a dead end the
 * customer understands is better than one that looks broken.
 */
function unusableReason(r: PaymentLinkRow): string | null {
  if (r.status !== 'active') return 'This payment link has been disabled.';
  if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
    return 'This payment link has expired.';
  }
  if (r.max_uses !== null && r.use_count >= r.max_uses) {
    return 'This payment link has already been used.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merchant side
// ---------------------------------------------------------------------------

export interface CreateLinkInput {
  clientId: string;
  title: string;
  description?: string | null;
  /** Crypto amount. Mutually exclusive with fiatAmount. */
  amount?: string | null;
  /** Fiat price; converted when the customer pays, not now. */
  fiatAmount?: string | null;
  fiatCurrency?: string | null;
  asset?: string | null;
  network?: string | null;
  reusable?: boolean;
  maxUses?: number | null;
  expiresAt?: string | null;
}

export async function createLink(input: CreateLinkInput): Promise<MerchantLink> {
  const hasCrypto = Boolean(input.amount);
  const hasFiat = Boolean(input.fiatAmount);

  if (hasCrypto && hasFiat) {
    // Two prices on one link is two answers to "what do I owe". The DB CHECK
    // would refuse it too; this is the readable version of that refusal.
    throw AppError.badRequest(
      'A link has one price: either `amount` (in crypto) or `fiatAmount` + `fiatCurrency`.',
    );
  }
  if (hasCrypto) {
    const n = Number(input.amount);
    if (!Number.isFinite(n) || n <= 0) {
      throw AppError.badRequest('amount must be a positive number, or omitted for an open amount');
    }
  }
  let fiatCurrency: string | null = null;
  if (hasFiat) {
    const n = Number(input.fiatAmount);
    if (!Number.isFinite(n) || n <= 0) {
      throw AppError.badRequest('fiatAmount must be a positive number');
    }
    // Validated at creation, not when a customer opens the link: a link priced
    // in a currency this gateway cannot quote would otherwise look fine in the
    // dashboard and fail in front of the customer.
    fiatCurrency = parseFiat(input.fiatCurrency);
  }

  // Validate the pin NOW, at creation, rather than when a customer opens the
  // link. A link pinned to an asset this gateway cannot settle would otherwise
  // look fine in the dashboard and fail in front of the customer.
  let network: Network | null = null;
  if (input.network) {
    network = parseNetwork(input.network);
  }
  let asset: string | null = null;
  if (input.asset) {
    if (!network) {
      throw AppError.badRequest('Pinning an asset also requires pinning a network');
    }
    asset = assetFor(network, input.asset).symbol;
  }

  // 24 bytes: this is a bearer capability in a URL, so it is sized to be
  // unguessable rather than pretty.
  const token = randomToken(24);

  const row = await queryOne<PaymentLinkRow>(
    `INSERT INTO payment_links
       (client_id, token, title, description, amount, fiat_amount, fiat_currency,
        asset, network, reusable, max_uses, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      input.clientId,
      token,
      input.title.trim(),
      input.description?.trim() || null,
      input.amount || null,
      input.fiatAmount || null,
      fiatCurrency,
      asset,
      network,
      input.reusable ?? true,
      input.maxUses ?? null,
      input.expiresAt ?? null,
    ],
  );
  if (!row) throw AppError.internal('failed to create payment link');
  return toMerchantLink(row);
}

export async function listLinks(clientId: string): Promise<MerchantLink[]> {
  const rows = await query<PaymentLinkRow>(
    `SELECT * FROM payment_links WHERE client_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [clientId],
  );
  return rows.map(toMerchantLink);
}

/** Disable (never delete): the link may already be in a customer's inbox. */
export async function setLinkStatus(
  clientId: string,
  id: string,
  status: 'active' | 'disabled',
): Promise<MerchantLink> {
  const row = await queryOne<PaymentLinkRow>(
    `UPDATE payment_links SET status = $3, updated_at = now()
      WHERE id = $1 AND client_id = $2
      RETURNING *`,
    [id, clientId, status],
  );
  if (!row) throw AppError.notFound('Payment link not found');
  return toMerchantLink(row);
}

// ---------------------------------------------------------------------------
// Public side
// ---------------------------------------------------------------------------

interface PublicRow extends PaymentLinkRow {
  business_name: string;
  client_status: string;
  has_invoice: boolean;
}

async function findByToken(token: string): Promise<PublicRow | null> {
  return queryOne<PublicRow>(
    `SELECT l.*, c.business_name, c.status::text AS client_status,
            EXISTS (SELECT 1 FROM invoices i WHERE i.payment_link_id = l.id) AS has_invoice
       FROM payment_links l
       JOIN clients c ON c.id = l.client_id
      WHERE l.token = $1`,
    [token],
  );
}

/** Resolve a link for the public checkout page. */
export async function getPublicLink(token: string): Promise<PublicLink> {
  const row = await findByToken(token);
  // A suspended merchant's links stop working. Reported as a plain 404 rather
  // than "this merchant is suspended", which is not the customer's business.
  if (!row || row.client_status !== 'approved') {
    throw AppError.notFound('This payment link does not exist.');
  }

  // Offer only what this gateway can settle AND what the link permits.
  const options = enabledAssets()
    .filter((a) => (row.network ? a.network === row.network : true))
    .filter((a) => (row.asset ? a.symbol === row.asset : true))
    .map((a) => ({
      symbol: a.symbol,
      network: a.network,
      name: a.name,
      isNative: a.isNative,
    }));

  const reason = unusableReason(row);
  return {
    token: row.token,
    title: row.title,
    description: row.description,
    merchantName: row.business_name,
    amount: row.amount,
    fiatAmount: row.fiat_amount,
    fiatCurrency: row.fiat_currency,
    hasInvoice: Boolean(row.has_invoice),
    asset: row.asset,
    network: row.network,
    options,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    usable: reason === null && options.length > 0,
    unusableReason:
      reason ??
      (options.length === 0
        ? 'This payment link is not currently accepting payments.'
        : null),
  };
}

/**
 * Claim one use of a link, atomically, and return everything the caller needs to
 * create the payment.
 *
 * The row lock is the whole point: the usability check and the increment happen
 * together, so a single-use link cannot be claimed twice by concurrent opens.
 * The caller creates the payment inside the SAME transaction (`tx`), so a
 * failure there rolls the increment back too — a link is never burned by a
 * payment that was not created.
 */
export async function claimLinkUse(
  tx: PoolClient,
  token: string,
): Promise<{ link: PaymentLinkRow; clientId: string; businessName: string }> {
  const res = await tx.query<PublicRow>(
    `SELECT l.*, c.business_name, c.status::text AS client_status
       FROM payment_links l
       JOIN clients c ON c.id = l.client_id
      WHERE l.token = $1
        FOR UPDATE OF l`,
    [token],
  );
  const row = res.rows[0];
  if (!row || row.client_status !== 'approved') {
    throw AppError.notFound('This payment link does not exist.');
  }

  const reason = unusableReason(row);
  if (reason) throw AppError.badRequest(reason);

  await tx.query(
    `UPDATE payment_links SET use_count = use_count + 1, updated_at = now()
      WHERE id = $1`,
    [row.id],
  );

  return { link: row, clientId: row.client_id, businessName: row.business_name };
}

/**
 * Public payment status. Scoped by the link token on purpose: the token is what
 * the customer legitimately holds, and requiring it means a leaked payment id
 * alone reveals nothing. Payments created through the API (no link) are never
 * readable here.
 */
export async function getPublicPayment(
  token: string,
  paymentId: string,
): Promise<{
  paymentId: string;
  status: string;
  amount: string;
  amountReceived: string;
  asset: string;
  network: string;
  address: string;
  confirmations: number;
  requiredConfirmations: number;
  txHash: string | null;
  expiresAt: string;
}> {
  const row = await queryOne<{
    id: string;
    status: string;
    amount: string;
    amount_received: string;
    asset: string;
    network: string;
    deposit_address: string;
    confirmations: number;
    required_confirmations: number;
    tx_hash: string | null;
    expires_at: string;
  }>(
    `SELECT p.id, p.status::text, p.amount, p.amount_received, p.asset, p.network,
            p.deposit_address, p.confirmations, p.required_confirmations,
            p.tx_hash, p.expires_at
       FROM payments p
       JOIN payment_links l ON l.id = p.payment_link_id
      WHERE p.id = $1 AND l.token = $2`,
    [paymentId, token],
  );
  if (!row) throw AppError.notFound('Payment not found.');

  return {
    paymentId: row.id,
    status: row.status,
    amount: row.amount,
    amountReceived: row.amount_received,
    asset: row.asset,
    network: row.network,
    address: row.deposit_address,
    confirmations: row.confirmations,
    requiredConfirmations: row.required_confirmations,
    txHash: row.tx_hash,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** Networks this gateway settles — used to validate a link's pin. */
export function settleableNetworks(): string[] {
  return enabledNetworks();
}
