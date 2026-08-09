/**
 * Merchant subscription routes (API key — either mode — or a dashboard session).
 *
 *   GET  /subscriptions              list
 *   POST /subscriptions              create
 *   GET  /subscriptions/:id          retrieve
 *   GET  /subscriptions/:id/invoices the invoices this plan has issued
 *   POST /subscriptions/:id/pause | /resume | /cancel
 *
 * Same authorisation reasoning as invoices: a subscription only ever creates
 * money-IN documents, so an API key may manage one. Nothing here can move funds
 * or change where they settle.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/apiError';
import { clientAuth, requireApprovedClient } from '../middleware/clientAuth';
import { requireScope } from '../middleware/auth';
import { SCOPES } from '../services/apiKeyService';
import { writeAudit } from '../services/auditService';
import { query } from '../db/pool';
import {
  INTERVAL_UNITS,
  createSubscription,
  getSubscription,
  listSubscriptions,
  setSubscriptionStatus,
} from '../services/subscriptionService';

const router = Router();

const CreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  amount: z.string().min(1),
  // Fiat: a subscription bills by issuing invoices, and an invoice is a fiat
  // document. Each cycle's crypto amount is quoted when it is paid.
  currency: z.string().min(3).max(3),
  intervalUnit: z.enum(INTERVAL_UNITS),
  intervalCount: z.number().int().min(1).max(366).default(1),
  customerName: z.string().max(200).optional(),
  customerEmail: z.string().email().max(320).optional(),
  asset: z.string().optional(),
  network: z.string().optional(),
  startAt: z.string().datetime().optional(),
  totalCycles: z.number().int().positive().max(10_000).optional(),
  dueDays: z.number().int().min(0).max(365).default(7),
  autoSend: z.boolean().optional(),
});

router.get(
  '/',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    res.status(200).json(await listSubscriptions(req.client!.clientId));
  }),
);

router.post(
  '/',
  clientAuth,
  requireApprovedClient,
  requireScope(SCOPES.paymentsWrite),
  asyncHandler(async (req, res) => {
    const body = CreateSchema.parse(req.body ?? {});
    const sub = await createSubscription({
      clientId: req.client!.clientId,
      ...body,
    });
    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'subscription.create',
      entityType: 'subscription',
      entityId: sub.id,
      metadata: {
        title: sub.title,
        amount: sub.amount,
        currency: sub.currency,
        interval: `${sub.intervalCount} ${sub.intervalUnit}`,
      },
      ip: req.ip,
    });
    res.status(201).json(sub);
  }),
);

router.get(
  '/:id',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    res.status(200).json(await getSubscription(req.client!.clientId, req.params.id));
  }),
);

/** The billing history for one plan: what was issued, and what was paid. */
router.get(
  '/:id/invoices',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    // Ownership is enforced by the subscription lookup, which 404s for another
    // merchant's id before any invoice row is read.
    await getSubscription(req.client!.clientId, req.params.id);
    const rows = await query(
      `SELECT i.id, i.number, i.total, i.currency, i.status, i.cycle_number,
              i.due_date, i.issued_at, i.paid_at, l.token
         FROM invoices i
         LEFT JOIN payment_links l ON l.id = i.payment_link_id
        WHERE i.subscription_id = $1
        ORDER BY i.cycle_number DESC
        LIMIT 200`,
      [req.params.id],
    );
    res.status(200).json(rows);
  }),
);

for (const action of ['pause', 'resume', 'cancel'] as const) {
  router.post(
    `/:id/${action}`,
    clientAuth,
    requireScope(SCOPES.paymentsWrite),
    asyncHandler(async (req, res) => {
      const sub = await setSubscriptionStatus(
        req.client!.clientId,
        req.params.id,
        action,
      );
      await writeAudit({
        actorUserId: req.user?.userId ?? null,
        actorType: 'user',
        action: `subscription.${action}`,
        entityType: 'subscription',
        entityId: sub.id,
        metadata: { status: sub.status, nextRunAt: sub.nextRunAt },
        ip: req.ip,
      });
      res.status(200).json(sub);
    }),
  );
}

export default router;
