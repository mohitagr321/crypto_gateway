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
import { withTransaction } from '../db/pool';
import { writeAudit } from '../services/auditService';
import { createPayment } from '../services/paymentService';
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
          ? { fiatAmount: link.fiat_amount!, fiatCurrency: link.fiat_currency! }
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
