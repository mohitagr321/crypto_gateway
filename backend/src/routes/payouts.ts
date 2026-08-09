/**
 * Merchant payout routes.
 *
 * Auth: `clientAuth` (JWT merchant OR API key).
 *   GET  /payouts   list this merchant's payouts as client-panel Payout[]
 *   POST /payouts   request a payout to the configured payout wallet -> 202
 *
 * SCOPE: creating a payout moves money out of the gateway, so it requires
 * `payouts:write`. Simple (bearer-token) keys are never issued that scope — see
 * services/apiKeyService.ts — so this route is reachable only with an
 * HMAC-signed key or a logged-in dashboard session. The destination is still
 * always the merchant's own configured wallet, which only a dashboard session
 * can change.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/apiError';
import { clientAuth, requireApprovedClient } from '../middleware/clientAuth';
import { requireScope } from '../middleware/auth';
import { SCOPES } from '../services/apiKeyService';
import { requestPayout, PayoutRow } from '../services/payoutService';
import { query } from '../db/pool';
import { mapPayoutStatusClient } from '../utils/statusMap';

const router = Router();

const PayoutSchema = z.object({
  amount: z.string().min(1),
  // Optional. Omitted -> BEP20 (back-compat). 'TRC20' only if enabled server-side
  // and the merchant has a payout_wallet_trc20 configured.
  network: z.string().optional(),
  // Omitted -> USDT. A payout can only draw on the balance of its own asset.
  asset: z.string().optional(),
});

/** Shape a payout DB row as the client-panel Payout. */
function toClientPayout(row: {
  id: string;
  gross_amount: string;
  status: string;
  to_address: string;
  network?: string;
  asset?: string;
  tx_hash: string | null;
  created_at: string;
}) {
  return {
    payoutId: row.id,
    amount: row.gross_amount,
    currency: row.asset ?? 'USDT',
    asset: row.asset ?? 'USDT',
    network: row.network ?? 'BEP20',
    status: mapPayoutStatusClient(row.status),
    wallet: row.to_address,
    txHash: row.tx_hash,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

router.get(
  '/',
  clientAuth,
  requireScope(SCOPES.paymentsRead),
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const rows = await query<{
      id: string;
      gross_amount: string;
      status: string;
      to_address: string;
      network: string;
      asset: string;
      tx_hash: string | null;
      created_at: string;
    }>(
      `SELECT id, gross_amount, status, to_address, network, asset, tx_hash, created_at
         FROM payouts
        WHERE client_id = $1
        ORDER BY created_at DESC`,
      [client.clientId],
    );
    res.status(200).json(rows.map(toClientPayout));
  }),
);

router.post(
  '/',
  clientAuth,
  requireApprovedClient,
  requireScope(SCOPES.payoutsWrite),
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const { amount, network, asset } = PayoutSchema.parse(req.body);
    const payout: PayoutRow = await requestPayout({
      clientId: client.clientId,
      amount,
      network,
      asset,
      type: 'manual',
      ip: req.ip,
    });
    res.status(202).json({
      ...toClientPayout(payout),
      // Extra fields (harmless for the client panel, useful to integrations).
      netAmount: payout.net_amount,
      commissionAmount: payout.commission_amount,
      toAddress: payout.to_address,
      network: payout.network,
    });
  }),
);

export default router;
