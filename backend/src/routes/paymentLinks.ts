/**
 * Payment links: merchant management + the PUBLIC hosted checkout.
 *
 * Merchant (authenticated, mounted at /payment-links):
 *   GET    /payment-links          list this merchant's links
 *   POST   /payment-links          create one
 *   POST   /payment-links/:id/disable | /enable
 *
 * Public (NO authentication, mounted at /pay):
 *   GET  /pay/:token                        resolve a link for the checkout page
 *   POST /pay/:token/payments               start a payment from it
 *   GET  /pay/:token/payments/:paymentId    poll its status
 *
 * ============================ THE PUBLIC SURFACE =============================
 * These three routes are reachable by anyone on the internet holding a link
 * URL. Two rules govern everything here, and both are easy to erode by
 * accident:
 *
 *  1. NEVER widen the response. `PublicLink` and `getPublicPayment` in
 *     services/paymentLinkService.ts define exactly what leaves the building:
 *     business name, amount, accepted assets, payment status. Not the merchant's
 *     id, email, wallet, balance, webhook, keys or other payments. Adding a
 *     field here publishes it to every customer who was ever sent a URL.
 *
 *  2. EVERY route is rate limited. Creating a payment derives an HD address and
 *     writes rows; unthrottled it is a cheap way to exhaust the derivation
 *     counter and fill the table. The read paths are limited more generously
 *     because the checkout page polls one of them every few seconds.
 */
import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { PoolClient } from 'pg';
import { asyncHandler, AppError } from '../utils/apiError';
import { clientAuth, requireApprovedClient } from '../middleware/clientAuth';
import { requireScope } from '../middleware/auth';
import { SCOPES } from '../services/apiKeyService';
import { checkoutReadLimiter, checkoutWriteLimiter } from '../middleware/rateLimit';
import { queryOne, withTransaction } from '../db/pool';
import { writeAudit } from '../services/auditService';
import { createPayment, PreQuoted } from '../services/paymentService';
import { enqueueWebhook } from '../services/webhookService';
import { quote } from '../services/rateService';
import { parseNetwork } from '../blockchain/networks';
import { parseAsset } from '../blockchain/assets';
import { logger } from '../config/logger';
import {
  claimLinkUse,
  createLink,
  getPublicLink,
  getPublicPayment,
  listLinks,
  setLinkStatus,
} from '../services/paymentLinkService';
import { getPublicInvoice } from '../services/invoiceService';

// ===========================================================================
// Merchant routes
// ===========================================================================

export const merchantLinkRouter = Router();

const CreateLinkSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  // Omitted/empty -> the customer types an amount (donations, top-ups).
  amount: z.string().optional(),
  // Price in fiat instead. Converted when the customer pays, not now.
  fiatAmount: z.string().optional(),
  fiatCurrency: z.string().min(3).max(3).optional(),
  // Pinning an asset requires pinning a network: the same symbol on two chains
  // is two different assets, so an asset alone is ambiguous.
  asset: z.string().optional(),
  network: z.string().optional(),
  reusable: z.boolean().default(true),
  maxUses: z.number().int().positive().max(100_000).optional(),
  expiresAt: z.string().datetime().optional(),
});

merchantLinkRouter.get(
  '/',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    res.status(200).json(await listLinks(req.client!.clientId));
  }),
);

merchantLinkRouter.post(
  '/',
  clientAuth,
  requireApprovedClient,
  requireScope(SCOPES.paymentsWrite),
  asyncHandler(async (req, res) => {
    const body = CreateLinkSchema.parse(req.body ?? {});
    const link = await createLink({
      clientId: req.client!.clientId,
      title: body.title,
      description: body.description,
      amount: body.amount,
      fiatAmount: body.fiatAmount,
      fiatCurrency: body.fiatCurrency,
      asset: body.asset,
      network: body.network,
      reusable: body.reusable,
      maxUses: body.maxUses,
      expiresAt: body.expiresAt,
    });
    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'payment_link.create',
      entityType: 'payment_link',
      entityId: link.id,
      metadata: { title: link.title, amount: link.amount, asset: link.asset },
      ip: req.ip,
    });
    res.status(201).json(link);
  }),
);

for (const [path, status] of [
  ['/:id/disable', 'disabled'],
  ['/:id/enable', 'active'],
] as const) {
  merchantLinkRouter.post(
    path,
    clientAuth,
    requireScope(SCOPES.paymentsWrite),
    asyncHandler(async (req, res) => {
      // Disable rather than delete: the URL may already be in a customer's
      // inbox, and a disabled link can explain itself where a 404 cannot.
      const link = await setLinkStatus(req.client!.clientId, req.params.id, status);
      await writeAudit({
        actorUserId: req.user?.userId ?? null,
        actorType: 'user',
        action: `payment_link.${status}`,
        entityType: 'payment_link',
        entityId: link.id,
        ip: req.ip,
      });
      res.status(200).json(link);
    }),
  );
}

// ===========================================================================
// Public checkout routes — NO AUTHENTICATION
// ===========================================================================

export const publicCheckoutRouter = Router();

publicCheckoutRouter.get(
  '/:token',
  checkoutReadLimiter,
  asyncHandler(async (req, res) => {
    res.status(200).json(await getPublicLink(req.params.token));
  }),
);

const StartPaymentSchema = z.object({
  // Only consulted when the link does not pin them.
  asset: z.string().optional(),
  network: z.string().optional(),
  amount: z.string().optional(),
});

publicCheckoutRouter.post(
  '/:token/payments',
  checkoutWriteLimiter,
  asyncHandler(async (req, res) => {
    const body = StartPaymentSchema.parse(req.body ?? {});
    const token = req.params.token;

    // ---- Strike the fiat quote BEFORE opening the transaction ---------------
    //
    // The conversion below reads the rate cache and, on a cold cache or an
    // entry past RATE_MAX_STALE_SECONDS, performs an OUTBOUND provider fetch —
    // up to several seconds. Done inside the transaction (which is where
    // createPayment does it when nobody supplies `preQuoted`) that fetch runs
    // while this request holds `claimLinkUse`'s `FOR UPDATE OF l` row lock AND
    // one of the pool's connections: every other customer on the same link
    // queues behind the lock, each holding a connection of their own, and a
    // provider outage turns a checkout burst into pool exhaustion.
    //
    // This read is UNLOCKED and advisory only. Nothing is decided from it:
    // createPayment re-resolves the asset and currency under the lock and
    // ignores this quote unless all three inputs match exactly, so a link
    // repriced in the gap is simply re-quoted the old way rather than mispriced.
    let preQuoted: PreQuoted | undefined;
    try {
      const pricing = await queryOne<{
        fiat_amount: string | null;
        fiat_currency: string | null;
        asset: string | null;
        network: string | null;
      }>(
        `SELECT fiat_amount, fiat_currency, asset, network
           FROM payment_links WHERE token = $1`,
        [token],
      );
      if (pricing?.fiat_amount && pricing.fiat_currency) {
        const symbol = parseAsset(
          parseNetwork(pricing.network ?? body.network),
          pricing.asset ?? body.asset,
        ).symbol;
        const q = await quote({
          asset: symbol,
          fiatCurrency: pricing.fiat_currency,
          fiatAmount: pricing.fiat_amount,
        });
        preQuoted = {
          asset: symbol,
          fiatCurrency: pricing.fiat_currency,
          fiatAmount: pricing.fiat_amount,
          amount: q.amount,
          locked: {
            currency: q.fiatCurrency,
            amount: q.fiatAmount,
            rate: q.rate,
            source: q.source,
            lockedAt: q.lockedAt,
          },
        };
      }
    } catch (err) {
      // Deliberately swallowed. Every failure reachable here — a disabled
      // network, an unpriceable asset, a rate-provider outage — is raised again
      // by createPayment from inside the transaction, against the asset the
      // LOCKED read resolved rather than the one guessed here. Failing now would
      // risk reporting the wrong reason; the only cost of continuing is that
      // this checkout keeps the old, slower shape.
      logger.debug({ err, token }, 'pre-transaction quote failed; quoting inside the transaction');
    }

    const payment = await withTransaction(async (tx: PoolClient) => {
      // Claims one use under a row lock. A single-use link cannot be claimed
      // twice by concurrent opens, and because createPayment joins THIS
      // transaction, a failure below rolls the claim back too.
      const { link, clientId } = await claimLinkUse(tx, token);

      // The link's pin always wins over anything the client sent — otherwise a
      // customer could edit the request and pay in an asset the merchant
      // deliberately excluded.
      const network = link.network ?? body.network;
      const asset = link.asset ?? body.asset;

      // The link's price also wins where it has one — a crafted request cannot
      // reduce a fixed price, because `body.amount` is only consulted for
      // open-amount links. `body.amount` is required in that case and nowhere else.
      //
      // A FIAT-priced link converts HERE, at payment creation, which is what
      // makes an invoice sent last week payable at this week's rate. The
      // customer's quote is then frozen onto their payment for its lifetime.
      const fiatPriced = Boolean(link.fiat_amount && link.fiat_currency);
      const amount = fiatPriced ? undefined : (link.amount ?? body.amount);
      if (!fiatPriced && (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
        throw AppError.badRequest('An amount is required to start this payment.');
      }

      return createPayment({
        clientId,
        amount,
        ...(fiatPriced
          ? {
              fiatAmount: link.fiat_amount!,
              fiatCurrency: link.fiat_currency!,
              // Used only if it was struck for exactly these values; see above.
              preQuoted,
            }
          : {}),
        // The customer has no order id, so mint one. It stays unique per client
        // (the table's constraint) and traces back to the link it came from.
        orderId: `link_${link.token.slice(0, 8)}_${ulid()}`,
        description: link.title,
        network: network ?? undefined,
        asset: asset ?? undefined,
        paymentLinkId: link.id,
        tx,
      });
    });

    // ---- payment.created, AFTER the commit -----------------------------------
    // This transaction owns the event. createPayment deliberately does not
    // enqueue it when a caller supplies `tx`, because enqueueWebhook reads the
    // payment back on a pooled connection and would find nothing while this
    // transaction was still open — which is why no hosted-checkout or invoice
    // payment has ever produced one. Enqueued here, the row is committed and
    // visible both to the read and to the worker that picks the job up.
    // Best-effort, exactly as on the direct API path: a merchant is not told
    // their payment failed because a webhook could not be queued.
    enqueueWebhook({ paymentId: payment.paymentId, event: 'payment.created' }).catch((err) =>
      logger.warn(
        { err, paymentId: payment.paymentId },
        'failed to enqueue payment.created webhook',
      ),
    );

    // Deliberately a trimmed shape rather than the merchant-facing DTO: the
    // customer needs an address, a QR and a status, not the payment's full
    // record.
    res.status(201).json({
      paymentId: payment.paymentId,
      amount: payment.amount,
      asset: payment.asset,
      network: payment.network,
      address: payment.address,
      qrCode: payment.qrCode,
      status: payment.status,
      expiresAt: payment.expiresAt,
      // The locked quote, so the page can say "₹5,000 at 95.09 — held until
      // 14:32". A customer paying a converted amount is entitled to see the
      // conversion; hiding it is how a checkout starts to look untrustworthy.
      ...(payment.fiat ? { fiat: payment.fiat } : {}),
      // Confirmation progress is deliberately not echoed here (it is always 0 on
      // a fresh payment); the status poll below reports it as it advances.
    });
  }),
);

/**
 * The invoice behind this link, when there is one.
 *
 * Mounted on the PUBLIC router deliberately: an invoice's pay link IS its
 * capability, so the customer holding the URL is exactly who should be able to
 * read the document. 404 when the link is a plain checkout link rather than an
 * invoice — the checkout page probes this and renders line items only if it
 * gets something back.
 *
 * The response shape is `PublicInvoice` in services/invoiceService.ts, and the
 * same rule applies as to `PublicLink`: whatever is listed there is published to
 * everyone who was ever sent this URL.
 */
publicCheckoutRouter.get(
  '/:token/invoice',
  checkoutReadLimiter,
  asyncHandler(async (req, res) => {
    res.status(200).json(await getPublicInvoice(req.params.token));
  }),
);

publicCheckoutRouter.get(
  '/:token/payments/:paymentId',
  checkoutReadLimiter,
  asyncHandler(async (req, res) => {
    // Scoped by the link token: a leaked payment id alone reveals nothing, and
    // API-created payments (no link) are never reachable here.
    res
      .status(200)
      .json(await getPublicPayment(req.params.token, req.params.paymentId));
  }),
);
