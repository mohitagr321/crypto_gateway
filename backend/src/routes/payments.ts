/**
 * Merchant payment routes (API key — HMAC-signed or simple bearer — or a
 * dashboard session).
 *   POST /payments        create a payment (idempotent via Idempotency-Key)
 *   GET  /payments        list payments (paginated)
 *   GET  /payments/:id    retrieve a payment
 *
 * Taking money IN is the one thing every credential can do, so both key modes
 * carry `payments:read` + `payments:write` by default. Moving money OUT lives in
 * routes/payouts.ts behind a scope simple keys never get.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../utils/apiError';
import { clientAuth, requireApprovedClient } from '../middleware/clientAuth';
import { requireScope } from '../middleware/auth';
import { SCOPES } from '../services/apiKeyService';
import { idempotency } from '../middleware/idempotency';
import {
  createPayment,
  getPayment,
  listPayments,
} from '../services/paymentService';

const router = Router();

const CreateSchema = z.object({
  // Optional ONLY because a payment may be priced in fiat instead. createPayment
  // rejects a request that supplies neither, or both — the mutual exclusion is
  // enforced there rather than here so the API and the checkout/invoice paths
  // that also call it get the same rule.
  amount: z.string().min(1).optional(),
  // Price in the merchant's own currency and let the gateway convert. The rate
  // is locked at creation and never revisited.
  fiatAmount: z.string().min(1).optional(),
  fiatCurrency: z.string().min(3).max(3).optional(),
  orderId: z.string().min(1),
  description: z.string().optional(),
  // Optional. Omitted -> BEP20 (back-compat). 'TRC20' only if enabled server-side.
  network: z.string().optional(),
  // Optional. Omitted -> USDT (back-compat). Must be enabled on `network`.
  asset: z.string().optional(),
});

router.post(
  '/',
  clientAuth,
  requireApprovedClient,
  requireScope(SCOPES.paymentsWrite),
  idempotency,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const body = CreateSchema.parse(req.body);
    const payment = await createPayment({
      clientId: client.clientId,
      amount: body.amount,
      fiatAmount: body.fiatAmount,
      fiatCurrency: body.fiatCurrency,
      orderId: body.orderId,
      description: body.description,
      network: body.network,
      asset: body.asset,
    });
    res.status(201).json(payment);
  }),
);

router.get(
  '/',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const result = await listPayments({
      clientId: client.clientId,
      status,
      page,
      limit,
    });
    res.status(200).json(result);
  }),
);

router.get(
  '/:id',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const id = req.params.id;
    if (!id) throw AppError.badRequest('payment id required');
    const payment = await getPayment(client.clientId, id);
    res.status(200).json(payment);
  }),
);

export default router;
