/**
 * Merchant payout routes.
 *
 * Auth: `clientAuth` (JWT merchant OR API key).
 *   GET  /payouts   paginated list of this merchant's payouts
 *   POST /payouts   request a payout to the configured payout wallet -> 202
 *
 * RESPONSE SHAPE CHANGE (GET /payouts): this used to return a BARE ARRAY of
 * every payout row the merchant had ever had — no LIMIT, no pagination, sorted
 * by created_at with no index to sort by. It now returns the same
 * `{ data, page, total }` envelope that GET /payments and every admin list route
 * already use. client-panel/src/lib/api.ts:443 already types the response as
 * `Payout[] | Paginated<Payout>` and unwraps `data.data`, so the panel keeps
 * working — but it sends no page/limit and has no pager, so it now renders the
 * most recent page rather than the whole history. `total` is in the response so
 * a pager can be added; older payouts are reachable today via ?page=N.
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

    // docs/openapi.yaml has ALWAYS documented `page` and `limit` on this route
    // (limit default 20) — the handler simply never read them, so an integrator
    // following the published contract silently received the entire history.
    // The default matches the spec rather than the 25 used elsewhere in this
    // codebase, because the spec is what clients were told. The 100 ceiling is
    // the same one listPayments and the admin lists apply.
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const offset = (page - 1) * limit;

    const totalRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payouts WHERE client_id = $1`,
      [client.clientId],
    );
    const total = Number(totalRows[0]?.count ?? '0');

    // ORDER BY is (created_at DESC, id DESC), not created_at alone. created_at
    // is not unique — the settle tick can create several payouts for one
    // merchant inside the same millisecond — and with a non-deterministic tie
    // break a row can appear on two pages or on none, which is precisely how a
    // paginated list silently drops work. The id tiebreak makes the ordering
    // total, so page N+1 resumes exactly where page N stopped.
    // Backed by idx_payouts_client_created (migration 022).
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
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [client.clientId, limit, offset],
    );

    res.status(200).json({ data: rows.map(toClientPayout), page, total });
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
