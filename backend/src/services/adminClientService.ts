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
 *   pendingBalance   = SUM(amount) of waiting/confirming payments
 *   availableBalance = volume - SUM(net_amount of sent/confirmed payouts)  (>= 0)
 */
import { query, queryOne } from '../db/pool';
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
  LEFT JOIN (
    SELECT client_id, SUM(amount_received) AS volume
      FROM payments WHERE status IN ('confirmed','swept')
     GROUP BY client_id
  ) vol ON vol.client_id = c.id
  LEFT JOIN (
    SELECT client_id, SUM(amount) AS pending_balance
      FROM payments WHERE status IN ('waiting','confirming')
     GROUP BY client_id
  ) pend ON pend.client_id = c.id
  LEFT JOIN (
    SELECT client_id, SUM(net_amount) AS paid_out
      FROM payouts WHERE status IN ('sent','confirmed')
     GROUP BY client_id
  ) po ON po.client_id = c.id
`;

function toAdminClient(row: ClientAggRow): AdminClient {
  const volume = Number(row.volume) || 0;
  const paidOut = Number(row.paid_out) || 0;
  const available = volume - paidOut;

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
    volume: String(volume),
    pendingBalance: row.pending_balance ?? '0',
    availableBalance: String(available < 0 ? 0 : available),
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
