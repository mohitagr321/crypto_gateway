/**
 * Merchant invoice routes (API key — either mode — or a dashboard session).
 *
 *   GET    /invoices             list
 *   POST   /invoices             create (draft or issued)
 *   GET    /invoices/:id         retrieve, with line items
 *   POST   /invoices/:id/send    email it to the customer
 *   POST   /invoices/:id/void    withdraw it and kill its pay link
 *
 * ============================ WHY AN API KEY MAY DO THIS =====================
 * Invoicing is money-IN, which is the one thing every credential is allowed to
 * do (see routes/payments.ts). Nothing here can move funds out, change where
 * settlements are paid, or mint a credential — those live behind
 * `requireDashboardSession`, and nothing in this file relaxes that.
 *
 * The one route that deserves its own restraint is `/send`, because it emits
 * email to an address the caller supplies. That gets `invoiceSendLimiter`, per
 * merchant per hour, on top of the usual key limiter.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/apiError';
import { clientAuth, requireApprovedClient } from '../middleware/clientAuth';
import { requireScope } from '../middleware/auth';
import { SCOPES } from '../services/apiKeyService';
import { invoiceSendLimiter } from '../middleware/rateLimit';
import { writeAudit } from '../services/auditService';
import {
  createInvoice,
  getInvoice,
  listInvoices,
  sendInvoice,
  voidInvoice,
} from '../services/invoiceService';

const router = Router();

const ItemSchema = z.object({
  description: z.string().min(1).max(500),
  // Strings throughout: these are decimal quantities parsed with BigInt
  // arithmetic, and routing them through a JS number would reintroduce exactly
  // the float error that arithmetic exists to avoid.
  quantity: z.string().optional(),
  unitPrice: z.string().min(1),
});

const CreateSchema = z.object({
  currency: z.string().min(3).max(3),
  items: z.array(ItemSchema).min(1).max(100),
  customerName: z.string().max(200).optional(),
  customerEmail: z.string().email().max(320).optional(),
  notes: z.string().max(2000).optional(),
  // Plain calendar date: an invoice is due on a day, not at an instant.
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxAmount: z.string().optional(),
  asset: z.string().optional(),
  network: z.string().optional(),
  // Default true: the common case is "make this and send it". A draft is the
  // deliberate choice, not the accidental one.
  issue: z.boolean().default(true),
});

router.get(
  '/',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.status(200).json(await listInvoices(req.client!.clientId, { status, limit }));
  }),
);

router.post(
  '/',
  clientAuth,
  requireApprovedClient,
  requireScope(SCOPES.paymentsWrite),
  asyncHandler(async (req, res) => {
    const body = CreateSchema.parse(req.body ?? {});
    const invoice = await createInvoice({
      clientId: req.client!.clientId,
      currency: body.currency,
      items: body.items,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      notes: body.notes,
      dueDate: body.dueDate,
      taxAmount: body.taxAmount,
      asset: body.asset,
      network: body.network,
      issue: body.issue,
    });
    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'invoice.create',
      entityType: 'invoice',
      entityId: invoice.id,
      metadata: {
        number: invoice.number,
        total: invoice.total,
        currency: invoice.currency,
        status: invoice.status,
      },
      ip: req.ip,
    });
    res.status(201).json(invoice);
  }),
);

router.get(
  '/:id',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    res.status(200).json(await getInvoice(req.client!.clientId, req.params.id));
  }),
);

router.post(
  '/:id/send',
  clientAuth,
  requireApprovedClient,
  requireScope(SCOPES.paymentsWrite),
  invoiceSendLimiter,
  asyncHandler(async (req, res) => {
    const result = await sendInvoice(req.client!.clientId, req.params.id);
    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'invoice.send',
      entityType: 'invoice',
      entityId: req.params.id,
      // The recipient is recorded because this route emits mail on the
      // merchant's behalf: if it is ever abused, "to whom" is the question.
      metadata: { to: result.to, delivered: result.sent },
      ip: req.ip,
    });
    // `sent: false` means SMTP is not configured and the message was logged
    // instead (the documented development behaviour), not that anything failed.
    res.status(200).json(result);
  }),
);

router.post(
  '/:id/void',
  clientAuth,
  requireScope(SCOPES.paymentsWrite),
  asyncHandler(async (req, res) => {
    const invoice = await voidInvoice(req.client!.clientId, req.params.id);
    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'invoice.void',
      entityType: 'invoice',
      entityId: invoice.id,
      metadata: { number: invoice.number },
      ip: req.ip,
    });
    res.status(200).json(invoice);
  }),
);

export default router;
