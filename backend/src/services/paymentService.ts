/**
 * Payment lifecycle service (create / get / list) and the OpenAPI Payment shaper.
 *
 * createPayment:
 *   0. If priced in fiat, convert to a crypto amount and FREEZE the rate.
 *   1. Reserve the next HD derivation index (atomic) — OUTSIDE the transaction.
 *   2. Derive a fresh deposit address — also outside, see below.
 *   3. Insert the wallet (type=deposit) + payment (status=waiting) in one txn.
 *   4. Generate a QR (EIP-681 token-transfer URI) as a base64 data URI.
 *   5. Return the OpenAPI Payment shape.
 *
 * ==================== STEPS 1 AND 2 ARE OUTSIDE THE TRANSACTION ==============
 * They used to be the first two statements INSIDE the transaction body, which
 * meant the index allocation's row lock was held (Postgres holds row locks to
 * COMMIT) across a ~3.4 ms synchronous key derivation, two INSERTs and the WAL
 * commit — serialising every payment creation in the entire fleet through one
 * row and capping creation at ~100-200/second regardless of replica count.
 *
 * Reserving before the transaction means a creation that then fails — a
 * duplicate orderId, a constraint violation, a rollback — burns its index. That
 * is deliberate and harmless: HD indexes are never reused, a burned one is just
 * an address no customer was ever shown, and the fiat-quote block below already
 * accepts the same tradeoff in the other direction. See utils/hdwallet.ts for
 * why nothing in the codebase depends on the indexes being gapless.
 *
 * ============================ FIAT PRICING LOCKS AT CREATION =================
 * A merchant may price in USD/INR/EUR instead of crypto. The conversion happens
 * exactly once, HERE, and the rate is written onto the payment row alongside the
 * resulting crypto amount.
 *
 * It is never recomputed. A customer who opens a checkout quoted at 5.234891
 * USDT and pays 25 minutes later owes 5.234891 USDT — the amount they were
 * shown, the amount the QR encodes, and the amount the listener compares
 * `amount_received` against. Re-deriving it from a live rate at confirmation
 * time would mean a payment could fail to confirm for a customer who paid
 * exactly what the page told them to.
 *
 * A payment priced directly in crypto never consults the rate service at all,
 * so a rate-provider outage cannot affect the path that predates fiat pricing.
 */
import { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { ulid } from 'ulid';
import { withTransaction, query, queryOne } from '../db/pool';
import { config } from '../config/env';
import { getNextDerivationIndex } from '../utils/hdwallet';
import { AppError } from '../utils/apiError';
import { logger } from '../config/logger';
import { adapterFor, Network, parseNetwork } from '../blockchain/networks';
import { parseAsset } from '../blockchain/assets';
import { enqueueWebhook } from './webhookService';
import { quote } from './rateService';

/**
 * ======================== QR RENDERING IS CACHED, NOT REPEATED ===============
 * `QRCode.toDataURL` is ~1.6 ms of synchronous PNG encoding on the shared event
 * loop. It ran once per creation AND again on EVERY `GET /payments/:id` for a
 * waiting/confirming payment — a checkout polling every few seconds for the full
 * 30-minute expiry window re-encoded the identical image several hundred times.
 *
 * The URI is immutable for a payment's lifetime (address, asset, network and
 * amount are all fixed at creation and never UPDATEd), so the rendered PNG is a
 * pure function of it. Caching by URI collapses those hundreds of renders to
 * one, with no change to the bytes any caller receives.
 *
 * Bounded, in-process, LRU by insertion order (Map preserves it; a hit is
 * re-inserted to mark it recent). ~2 KB per entry, so the cap is a few MB. It is
 * per-replica and lossy by design — a miss just re-renders. Keys are deposit
 * URIs, which are unique per payment, so no entry is ever shared between two
 * payments.
 */
const QR_CACHE_MAX = 2_000;
const qrCache = new Map<string, string>();

async function renderQr(uri: string): Promise<string> {
  const hit = qrCache.get(uri);
  if (hit !== undefined) {
    qrCache.delete(uri);
    qrCache.set(uri, hit);
    return hit;
  }
  const dataUrl = await QRCode.toDataURL(uri);
  if (qrCache.size >= QR_CACHE_MAX) {
    const oldest = qrCache.keys().next();
    if (!oldest.done) qrCache.delete(oldest.value);
  }
  qrCache.set(uri, dataUrl);
  return dataUrl;
}

/**
 * The wallet-scannable URI for a payment, or undefined if this deployment can no
 * longer build one (the network was disabled after the payment was created).
 * Pure string work — safe to compute for every row of a list.
 */
function paymentUriFor(row: PaymentRow): string | undefined {
  try {
    const net = parseNetwork(row.network);
    return adapterFor(net).paymentUri(row.deposit_address, row.amount, row.asset);
  } catch {
    return undefined;
  }
}

/** The frozen fiat quote, assembled once and written once. */
export interface LockedQuote {
  currency: string;
  amount: string;
  rate: string;
  source: string;
  lockedAt: Date;
}

/**
 * A quote a CALLER already struck, so `createPayment` does not have to strike it
 * itself. See `CreatePaymentInput.preQuoted` for why that matters.
 *
 * It carries the inputs the quote was struck FOR as well as its result. Those
 * inputs are re-checked here against the ones this call actually resolved, and
 * anything that does not match exactly is quoted again from scratch — a
 * mispriced payment is a fund-loss bug, and "the caller probably meant the same
 * thing" is not a basis on which to write an amount onto a payment row.
 */
export interface PreQuoted {
  /** Asset symbol the quote was struck for, e.g. 'USDT'. */
  asset: string;
  /** Exactly the `fiatCurrency` that was passed to `quote()`. */
  fiatCurrency: string;
  /** Exactly the `fiatAmount` that was passed to `quote()`. */
  fiatAmount: string;
  /** The resulting crypto amount, in `asset`. */
  amount: string;
  locked: LockedQuote;
}

export interface PaymentRow {
  id: string;
  client_id: string;
  order_id: string;
  description: string | null;
  amount: string;
  amount_received: string;
  currency: string;
  asset: string;
  network: string;
  deposit_address: string;
  wallet_id: string;
  status: string;
  confirmations: number;
  required_confirmations: number;
  tx_hash: string | null;
  expires_at: string;
  confirmed_at: string | null;
  /** Null on a crypto-priced payment. All four move together — see the CHECK. */
  fiat_currency: string | null;
  fiat_amount: string | null;
  fiat_rate: string | null;
  rate_source: string | null;
  rate_locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentDTO {
  paymentId: string;
  orderId: string;
  amount: string;
  amountReceived: string;
  currency: string;
  /**
   * Ledger asset. Always equal to `currency` — both are returned because
   * `currency` is the historical field name in the published API and `asset` is
   * what the multi-asset endpoints (balances, filters) key on.
   */
  asset: string;
  network: string;
  address: string;
  qrCode?: string;
  /**
   * The same wallet-scannable URI the `qrCode` PNG encodes, as plain text.
   *
   * Returned so a client can render the QR itself instead of paying for a
   * server-side PNG encode — and so it can do so WITHOUT losing information:
   * rendering a QR from `address` alone silently drops the token contract (EVM)
   * or the amount (BIP-21), which is exactly the trap the panel's own fallback
   * falls into today. `qrCode` is unchanged and still populated; this is purely
   * additive.
   *
   * Present under exactly the same conditions as `qrCode` — while the payment is
   * still payable at its original amount — so the two can never disagree.
   */
  paymentUri?: string;
  status: string;
  confirmations: number;
  txHash: string | null;
  expiresAt: string;
  createdAt: string;
  /**
   * The locked fiat quote, present only when the payment was priced in fiat.
   * Returned as a nested object rather than five loose fields so it is obvious
   * they are one indivisible record — and so its absence reads as "priced in
   * crypto" rather than as five separate nulls.
   */
  fiat?: {
    currency: string;
    amount: string;
    /** Price of one unit of `asset` in `currency`, at `lockedAt`. */
    rate: string;
    /** e.g. 'coingecko' or 'coingecko:stale'. */
    source: string | null;
    lockedAt: string | null;
  };
}

export interface CreatePaymentInput {
  clientId: string;
  /**
   * Amount in `asset`. Omit when pricing in fiat — exactly one of `amount` or
   * (`fiatAmount` + `fiatCurrency`) must be given. Accepting both would leave
   * two sources of truth for what the customer owes, and no way to tell which
   * one the checkout page showed them.
   */
  amount?: string;
  /** Price in fiat instead. Converted and frozen here; see the header. */
  fiatAmount?: string;
  /** ISO-4217 code, e.g. 'INR'. Required with `fiatAmount`. */
  fiatCurrency?: string;
  orderId: string;
  description?: string;
  /** 'BEP20' (default) | 'TRC20'. Rejected if the network is not enabled. */
  network?: string;
  /**
   * Token symbol on that network, e.g. 'USDC'. Defaults to USDT, exactly as
   * `network` defaults to BEP20 — an integration that predates multi-asset keeps
   * its behaviour. Rejected if the asset is not enabled on `network`.
   */
  asset?: string;
  /**
   * Set when the payment is started from a hosted checkout link. Also what makes
   * the payment readable by the PUBLIC status endpoint — API-created payments
   * have this NULL and stay private.
   */
  paymentLinkId?: string | null;
  /**
   * A fiat quote the caller already struck, OUTSIDE any transaction.
   *
   * Only consulted for a fiat-priced payment, and only when every input it
   * records matches the ones resolved here — otherwise it is ignored and the
   * quote is struck normally. Supplying it never changes what is written; it
   * only changes WHERE the (possibly slow, possibly outbound-HTTP) conversion
   * happened.
   *
   * A caller that owns the transaction (`tx`) and prices in fiat SHOULD supply
   * this: without it the rate lookup — which on a cold cache performs an
   * outbound provider fetch — runs with that caller's transaction already open,
   * holding both its row locks and its pool connection for the duration.
   */
  preQuoted?: PreQuoted;
  /**
   * Run inside a transaction the CALLER owns, so link-claim + payment-creation
   * commit or roll back together. Without this a failure here would leave a
   * single-use link burned by a payment that was never created.
   *
   * A caller that passes this OWNS THE `payment.created` WEBHOOK: it is not
   * enqueued here, because the enqueue reads the payment back on a POOLED
   * connection and the caller's transaction has not committed yet, so the read
   * finds nothing and the event is silently dropped. See the enqueue site
   * below, and `routes/paymentLinks.ts` for the post-commit call.
   */
  tx?: PoolClient;
}

export async function createPayment(
  input: CreatePaymentInput,
): Promise<PaymentDTO> {
  const pricedInFiat = Boolean(input.fiatAmount || input.fiatCurrency);
  const pricedInCrypto = input.amount !== undefined && input.amount !== null && input.amount !== '';

  // Exactly one pricing basis. Both would mean two answers to "what is owed";
  // neither would mean none.
  if (pricedInFiat && pricedInCrypto) {
    throw AppError.badRequest(
      'Provide either `amount` (in crypto) or `fiatAmount` + `fiatCurrency`, not both.',
    );
  }
  if (!pricedInFiat && !pricedInCrypto) {
    throw AppError.badRequest(
      'An amount is required: either `amount` (in crypto) or `fiatAmount` + `fiatCurrency`.',
    );
  }
  if (pricedInFiat && (!input.fiatAmount || !input.fiatCurrency)) {
    throw AppError.badRequest(
      'Pricing in fiat requires both `fiatAmount` and `fiatCurrency`.',
    );
  }
  if (pricedInCrypto && (Number.isNaN(Number(input.amount)) || Number(input.amount) <= 0)) {
    throw AppError.badRequest('amount must be a positive number');
  }
  if (!input.orderId || input.orderId.length === 0) {
    throw AppError.badRequest('orderId is required');
  }

  // Resolve the target chain. parseNetwork defaults to BEP20 for callers that
  // never send `network`, and adapterFor throws a 400 if TRC20 is not enabled —
  // so an unconfigured Tron deployment can never mint a Tron deposit address.
  const network: Network = parseNetwork(input.network);
  const adapter = adapterFor(network);
  // Throws 400 for a symbol this deployment does not settle on this chain,
  // rather than silently falling back to USDT — crediting a payment against the
  // wrong token is a fund-loss bug.
  const asset = parseAsset(network, input.asset);

  // ---- Freeze the quote, if this is a fiat-priced payment ------------------
  // Deliberately BEFORE the transaction and before any HD index is reserved: a
  // rate-provider failure should cost nothing but a 503. Burning a derivation
  // index on a payment that then fails to price is pure waste.
  let locked: LockedQuote | null = null;
  let amount: string;
  if (pricedInFiat) {
    // A caller-supplied quote is used ONLY when it was struck for exactly the
    // asset, currency and fiat amount this call resolved. Any difference —
    // including a link whose price changed between the caller's read and its
    // lock — falls through to a fresh quote rather than pricing the payment
    // from a stale intent.
    const pre = input.preQuoted;
    const preUsable =
      pre !== undefined &&
      pre.asset === asset.symbol &&
      pre.fiatCurrency === input.fiatCurrency &&
      pre.fiatAmount === input.fiatAmount;

    if (preUsable) {
      amount = pre!.amount;
      locked = pre!.locked;
    } else {
      const q = await quote({
        asset: asset.symbol,
        fiatCurrency: input.fiatCurrency!,
        fiatAmount: input.fiatAmount!,
      });
      amount = q.amount;
      locked = {
        currency: q.fiatCurrency,
        amount: q.fiatAmount,
        rate: q.rate,
        source: q.source,
        lockedAt: q.lockedAt,
      };
    }
    if (locked.source.endsWith(':stale')) {
      // Not an error — this is the degraded mode working as designed — but a
      // quote struck against an old price is worth being able to find later.
      logger.warn(
        { asset: asset.symbol, fiat: locked.currency, lockedAt: locked.lockedAt },
        'payment quoted from a stale exchange rate',
      );
    }
  } else {
    amount = input.amount!;
  }

  const paymentId = `pay_${ulid()}`;
  const expiresAt = new Date(
    Date.now() + config.paymentExpiryMinutes * 60_000,
  ).toISOString();

  // ---- Reserve the HD index and derive the address, BEFORE the transaction --
  // Both were previously inside the transaction body; see the header. The
  // reservation is a bare `nextval()` that takes no transactional lock, and the
  // derivation is pure CPU with no DB involvement, so neither belongs in a
  // window that holds locks. Ordered AFTER the fiat quote so a rate-provider
  // outage still costs nothing.
  //
  // `input.tx` is passed through DELIBERATELY. When the hosted checkout has
  // already opened a transaction to claim the link's use, reaching for a second
  // pooled connection here would make this request hold one connection while
  // waiting for another — DB_POOL_MAX concurrent checkout starts would then all
  // wait on connections only they can release. nextval() takes no transactional
  // lock, so borrowing the caller's connection costs it nothing; see
  // getNextDerivationIndex for the savepoint that keeps a pre-migration failure
  // from poisoning that transaction.
  const index = await getNextDerivationIndex(input.tx);
  const derived = adapter.deriveDeposit(index);

  const body = async (client: PoolClient): Promise<PaymentRow> => {
    // Enforce (client_id, order_id) uniqueness with a friendly error.
    const dup = await client.query(
      `SELECT id FROM payments WHERE client_id = $1 AND order_id = $2`,
      [input.clientId, input.orderId],
    );
    if (dup.rowCount && dup.rowCount > 0) {
      throw AppError.conflict(`orderId "${input.orderId}" already exists`);
    }

    // 2. Insert deposit wallet, tagged with its network. `idx_wallets_deriv`
    //    (UNIQUE derivation_index WHERE type='deposit') is the backstop that
    //    makes two payments sharing a deposit address impossible even if the
    //    allocator were ever wrong: a duplicate fails this INSERT with 23505 and
    //    rolls the whole creation back.
    const walletRes = await client.query<{ id: string }>(
      `INSERT INTO wallets (client_id, address, network, type, derivation_index)
       VALUES ($1, $2, $3, 'deposit', $4)
       RETURNING id`,
      [input.clientId, derived.address, network, index],
    );
    const walletId = walletRes.rows[0].id;

    // 3. Insert payment.
    const payRes = await client.query<PaymentRow>(
      // `currency` and `asset` are written together and kept equal: `currency`
      // is part of the published API response shape, `asset` is what the ledger
      // joins and groups on.
      //
      // The fiat columns are written here and nowhere else in the codebase.
      // Nothing UPDATEs them: they record a decision, not a current value.
      `INSERT INTO payments
         (id, client_id, order_id, description, amount, currency, asset, network,
          deposit_address, wallet_id, status, required_confirmations, expires_at,
          payment_link_id,
          fiat_currency, fiat_amount, fiat_rate, rate_source, rate_locked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, 'waiting', $10, $11, $12,
               $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        paymentId,
        input.clientId,
        input.orderId,
        input.description ?? null,
        amount,
        asset.symbol,
        network,
        derived.address,
        walletId,
        adapter.requiredConfirmations,
        expiresAt,
        input.paymentLinkId ?? null,
        locked?.currency ?? null,
        locked?.amount ?? null,
        locked?.rate ?? null,
        locked?.source ?? null,
        locked?.lockedAt ?? null,
      ],
    );
    return payRes.rows[0];
  };

  // Join the caller's transaction when given one; otherwise own it.
  const row = input.tx ? await body(input.tx) : await withTransaction(body);

  // Fire the 'payment.created' (waiting) webhook — best-effort, must not fail
  // the API call. Merchants receive an event for every status, starting here.
  //
  // ONLY when this function owned the transaction. enqueueWebhook's first act is
  // to read the payment back through the POOL (a different connection), so while
  // a caller's transaction is still open that read cannot see the row: it logs
  // 'payment not found', returns null, writes no webhook_logs row and throws
  // nothing, so the .catch below never fires and the event is lost in silence.
  // That is why every hosted-checkout and invoice payment has never emitted
  // payment.created. The owning caller enqueues it after ITS commit instead.
  if (!input.tx) {
    enqueueWebhook({ paymentId: row.id, event: 'payment.created' }).catch((err) =>
      logger.warn({ err, paymentId: row.id }, 'failed to enqueue payment.created webhook'),
    );
  }

  // 4. QR (outside the txn — pure/no DB). URI shape is chain-specific.
  //    Rendering here also warms the cache, so the status polls that follow this
  //    payment for the next 30 minutes cost nothing.
  let qrCode: string | undefined;
  try {
    qrCode = await renderQr(
      adapter.paymentUri(row.deposit_address, row.amount, row.asset),
    );
  } catch (err) {
    logger.warn({ err, paymentId }, 'failed to render QR; returning without it');
  }

  return toDTO(row, qrCode);
}

export async function getPayment(
  clientId: string,
  paymentId: string,
): Promise<PaymentDTO> {
  const row = await queryOne<PaymentRow>(
    `SELECT * FROM payments WHERE id = $1 AND client_id = $2`,
    [paymentId, clientId],
  );
  if (!row) {
    throw AppError.notFound('Payment not found');
  }
  // Re-serve the QR for waiting/confirming payments so the panel can re-display
  // it. The status set is deliberately UNCHANGED — in particular 'partial' is
  // still excluded, because every URI here encodes the ORIGINAL amount (BIP-21
  // carries it explicitly) and handing a part-paid customer a QR for the full
  // amount would invite an overpayment. The panel's address-only fallback stays
  // correct for that case.
  //
  // This is now a CACHE READ in the overwhelming majority of cases — the URI has
  // not changed since creation — so the poll no longer re-encodes a PNG.
  let qrCode: string | undefined;
  if (row.status === 'waiting' || row.status === 'confirming') {
    const uri = paymentUriFor(row);
    if (uri) {
      try {
        qrCode = await renderQr(uri);
      } catch {
        /* ignore — QR is a convenience, not load-bearing */
      }
    }
  }
  return toDTO(row, qrCode);
}

export interface ListParams {
  clientId: string;
  status?: string;
  page?: number;
  limit?: number;
}

export async function listPayments(
  params: ListParams,
): Promise<{ data: PaymentDTO[]; page: number; total: number }> {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(100, Math.max(1, params.limit ?? 25));
  const offset = (page - 1) * limit;

  const where: string[] = ['client_id = $1'];
  const args: unknown[] = [params.clientId];
  if (params.status) {
    args.push(params.status);
    where.push(`status = $${args.length}`);
  }
  const whereSql = where.join(' AND ');

  const totalRows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM payments WHERE ${whereSql}`,
    args,
  );
  const total = Number(totalRows[0]?.count ?? '0');

  const dataArgs = [...args, limit, offset];
  const rows = await query<PaymentRow>(
    `SELECT * FROM payments
      WHERE ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${dataArgs.length - 1} OFFSET $${dataArgs.length}`,
    dataArgs,
  );

  return { data: rows.map((r) => toDTO(r)), page, total };
}

/** Map a DB row to the OpenAPI Payment schema. */
export function toDTO(row: PaymentRow, qrCode?: string): PaymentDTO {
  // Same gate as the server-rendered QR: only while the payment is still payable
  // at the amount the URI encodes.
  const payable = row.status === 'waiting' || row.status === 'confirming';
  const uri = payable ? paymentUriFor(row) : undefined;
  return {
    paymentId: row.id,
    orderId: row.order_id,
    amount: row.amount,
    amountReceived: row.amount_received,
    currency: row.currency,
    asset: row.asset ?? row.currency,
    network: row.network,
    address: row.deposit_address,
    ...(qrCode ? { qrCode } : {}),
    ...(uri ? { paymentUri: uri } : {}),
    status: row.status,
    confirmations: row.confirmations,
    txHash: row.tx_hash,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    // Present only when the payment was priced in fiat. The CHECK constraint
    // guarantees currency/amount/rate are all set or all null, so testing one
    // is enough.
    ...(row.fiat_currency && row.fiat_amount && row.fiat_rate
      ? {
          fiat: {
            currency: row.fiat_currency,
            amount: row.fiat_amount,
            rate: row.fiat_rate,
            source: row.rate_source,
            lockedAt: row.rate_locked_at
              ? new Date(row.rate_locked_at).toISOString()
              : null,
          },
        }
      : {}),
  };
}
