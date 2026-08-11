/**
 * Admin-panel client shaping.
 *
 * Builds the admin-panel `Client` object from the DB, including derived
 * aggregates (volume / pendingBalance / availableBalance), the active API key,
 * and the active commission (in the admin-panel Commission shape). Status enums
 * are mapped to the admin-panel vocabulary via statusMap.
 *
 * Aggregates are APPROXIMATE by design:
 *   volume           = SUM(amount_received) of confirmed/swept payments
 *   pendingBalance   = SUM(amount) of waiting/confirming/partial payments
 *   availableBalance = volume - SUM(gross_amount of RESERVED payouts)  (>= 0)
 *
 * ===================== READ THIS BEFORE TRUSTING THE NUMBERS =================
 * They are summed ACROSS (network, asset). A merchant holding 0.4 BTC and 200
 * USDT shows as "200.4", which is a quantity of nothing. Balances in this system
 * are never fungible across a (network, asset) pair — getAllBalances
 * (services/payoutService.ts) is the correct, per-pair view, and getBalanceWith
 * is the guard that actually decides whether a payout may be created. These
 * three fields exist for the admin-panel's client list and gate nothing in code;
 * fixing them properly means returning a per-pair breakdown, which is a breaking
 * change to the panel contract and is not done here.
 *
 * Two things WERE fixed, because they were wrong in ways that mattered even for
 * a rough figure:
 *   - the arithmetic was JS float over NUMERIC(38,18) strings
 *     (Number('123456789.123456789012345678') -> 123456789.12345679). It is now
 *     BigInt at the ledger accounting scale, like every other money path.
 *   - `availableBalance` subtracted only `net_amount` of ('sent','confirmed')
 *     payouts, so a payout that was requested but not yet broadcast was invisible
 *     and the figure read HIGHER than what a payout could actually draw. It now
 *     uses the same quantity and the same reserved-status set as the payout guard
 *     (gross_amount over pending/processing/sent/confirmed/unresolved), so it can
 *     only ever under-report. An operator sizing a manual payout off this number
 *     now gets rejected by the guard less often, never more.
 */
import { query, queryOne } from '../db/pool';
import { fromAccountingUnits, toAccountingUnits } from '../utils/money';
import { mapClientStatus, unmapClientStatus } from '../utils/statusMap';

export interface AdminCommission {
  id?: string;
  clientId: string;
  type: 'percentage' | 'fixed' | 'tiered';
  value: string;
  tiers?: import('./commissionService').CommissionTier[] | null;
  feePayer: 'client' | 'admin';
  /**
   * Denomination of the amounts in this commission, and the chain it is scoped
   * to. Surfaced because settlement now REFUSES an amount-denominated commission
   * in an asset other than the one being settled — an operator who cannot see
   * which asset the fee is written in cannot tell why a payout is being skipped.
   * Both null on a percentage rate, which has no denomination.
   */
  asset: string | null;
  network: string | null;
  createdAt?: string;
  createdBy?: string;
}

export interface AdminClient {
  id: string;
  name: string;
  email: string;
  status: string;
  /** 'self' = registered through the public panel; 'admin' = provisioned here. */
  signupSource: 'admin' | 'self';
  /** Self-registered accounts are approved BY verifying their email. */
  emailVerified: boolean;
  websiteUrl: string | null;
  country: string | null;
  apiKey: string;
  webhookUrl: string | null;
  payoutWallet: string | null;
  /** TRC20 (T…) settlement address; null = merchant does not take TRC20 payouts. */
  payoutWalletTrc20: string | null;
  commission: AdminCommission | null;
  volume: string;
  pendingBalance: string;
  availableBalance: string;
  createdAt: string;
  updatedAt: string;
}

/** Row shape returned by the aggregate client SELECT. */
interface ClientAggRow {
  id: string;
  business_name: string;
  email: string;
  status: string;
  signup_source: 'admin' | 'self';
  email_verified: boolean;
  website_url: string | null;
  country: string | null;
  webhook_url: string | null;
  payout_wallet: string | null;
  payout_wallet_trc20: string | null;
  api_key: string | null;
  volume: string;
  pending_balance: string;
  paid_out: string;
  created_at: string;
  updated_at: string;
  c_id: string | null;
  c_type: string | null;
  c_value: string | null;
  c_tiers: import('./commissionService').CommissionTier[] | null;
  c_fee_payer: string | null;
  c_asset: string | null;
  c_network: string | null;
  c_created_at: string | null;
  c_created_by: string | null;
}

const CLIENT_SELECT = `
  SELECT
    c.id,
    c.business_name,
    u.email,
    c.status,
    c.signup_source,
    c.website_url,
    c.country,
    u.email_verified,
    c.webhook_url,
    c.payout_wallet,
    c.payout_wallet_trc20,
    c.created_at,
    c.updated_at,
    ak.api_key,
    COALESCE(vol.volume, 0)::text          AS volume,
    COALESCE(pend.pending_balance, 0)::text AS pending_balance,
    COALESCE(po.paid_out, 0)::text          AS paid_out,
    com.id         AS c_id,
    com.type::text AS c_type,
    com.value::text AS c_value,
    com.tiers      AS c_tiers,
    com.network_fee_payer::text AS c_fee_payer,
    com.asset      AS c_asset,
    com.network    AS c_network,
    com.created_at AS c_created_at,
    com.created_by AS c_created_by
  FROM clients c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN LATERAL (
    SELECT api_key FROM api_keys
     WHERE client_id = c.id AND status = 'active'
     ORDER BY created_at DESC LIMIT 1
  ) ak ON true
  LEFT JOIN LATERAL (
    SELECT * FROM commissions
     WHERE client_id = c.id AND is_active = true
     ORDER BY created_at DESC LIMIT 1
  ) com ON true
  -- CORRELATED, NOT WHOLE-TABLE. These were three ungrouped subqueries that
  -- aggregated EVERY payment and EVERY payout in the database, grouped by
  -- client_id, and then threw all but the rows on this page away — on every
  -- client-list page load AND on every single-client fetch. Written as LATERAL
  -- scans correlated to c.id they are served by
  -- idx_payments_client_network_asset_status / idx_payouts_client_* , which lead
  -- with client_id. The values are identical: summing one client's rows is the
  -- same number whether or not every other client was summed alongside.
  LEFT JOIN LATERAL (
    SELECT SUM(amount_received) AS volume
      FROM payments
     WHERE client_id = c.id AND status IN ('confirmed','swept')
  ) vol ON true
  LEFT JOIN LATERAL (
    -- 'partial' is an underpaid payment whose funds HAVE arrived and are still
    -- in flight toward the invoice; getAllBalances counts it as pending and this
    -- must not disagree with it.
    SELECT SUM(amount) AS pending_balance
      FROM payments
     WHERE client_id = c.id AND status IN ('waiting','confirming','partial')
  ) pend ON true
  LEFT JOIN LATERAL (
    -- gross_amount over the RESERVED set, matching getBalanceWith exactly:
    -- 'failed' is the only status that releases a reservation, and 'unresolved'
    -- (a payout whose transaction may already be on chain) must stay reserved.
    SELECT SUM(gross_amount) AS paid_out
      FROM payouts
     WHERE client_id = c.id
       AND status IN ('pending','processing','sent','confirmed','unresolved')
  ) po ON true
`;

function toAdminClient(row: ClientAggRow): AdminClient {
  // BigInt at the ledger accounting scale — never a float. The inputs are
  // NUMERIC(38,18) rendered as strings and routinely carry more significant
  // digits than a double can hold.
  const volumeU = toAccountingUnits(row.volume ?? '0');
  const paidOutU = toAccountingUnits(row.paid_out ?? '0');
  const availableU = volumeU - paidOutU;

  const commission: AdminCommission | null =
    row.c_id && row.c_type && row.c_value
      ? {
          id: row.c_id,
          clientId: row.id,
          type: row.c_type as 'percentage' | 'fixed' | 'tiered',
          value: row.c_value,
          tiers: row.c_tiers ?? null,
          feePayer: (row.c_fee_payer as 'client' | 'admin') ?? 'client',
          asset: row.c_asset ?? null,
          network: row.c_network ?? null,
          createdAt: row.c_created_at
            ? new Date(row.c_created_at).toISOString()
            : undefined,
          createdBy: row.c_created_by ?? undefined,
        }
      : null;

  return {
    id: row.id,
    name: row.business_name,
    email: row.email,
    status: mapClientStatus(row.status),
    signupSource: row.signup_source ?? 'admin',
    emailVerified: row.email_verified ?? true,
    websiteUrl: row.website_url,
    country: row.country,
    apiKey: row.api_key ?? '',
    webhookUrl: row.webhook_url,
    payoutWallet: row.payout_wallet,
    payoutWalletTrc20: row.payout_wallet_trc20,
    commission,
    // Both rendered from the same accounting scale the arithmetic was done in,
    // so the strings the panel formats are exactly the values that were summed.
    volume: fromAccountingUnits(volumeU),
    pendingBalance: row.pending_balance ?? '0',
    availableBalance: fromAccountingUnits(availableU < 0n ? 0n : availableU),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getAdminClient(clientId: string): Promise<AdminClient | null> {
  const row = await queryOne<ClientAggRow>(
    `${CLIENT_SELECT} WHERE c.id = $1`,
    [clientId],
  );
  return row ? toAdminClient(row) : null;
}

export interface ListAdminClientsParams {
  status?: string; // panel status (may be 'active' -> DB 'approved')
  /** Filter to merchants who signed themselves up, or who an operator created. */
  signupSource?: 'admin' | 'self';
  page: number;
  limit: number;
}

export async function listAdminClients(
  params: ListAdminClientsParams,
): Promise<{ data: AdminClient[]; page: number; total: number; limit: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.status) {
    args.push(unmapClientStatus(params.status));
    where.push(`c.status = $${args.length}`);
  }
  if (params.signupSource) {
    args.push(params.signupSource);
    where.push(`c.signup_source = $${args.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM clients c ${whereSql}`,
    args,
  );
  const total = Number(totalRows[0]?.count ?? '0');

  const offset = (params.page - 1) * params.limit;
  const dataArgs = [...args, params.limit, offset];
  const rows = await query<ClientAggRow>(
    `${CLIENT_SELECT} ${whereSql}
      ORDER BY c.created_at DESC
      LIMIT $${dataArgs.length - 1} OFFSET $${dataArgs.length}`,
    dataArgs,
  );

  return {
    data: rows.map(toAdminClient),
    page: params.page,
    total,
    limit: params.limit,
  };
}
