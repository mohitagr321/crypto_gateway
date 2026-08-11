/**
 * Admin dashboard routes (JWT + role guard).
 *
 *   GET  /admin/clients             paginated admin Client list (optional status)
 *   GET  /admin/clients/:id         single admin Client
 *   POST /admin/clients             create user + client + API key (secrets shown ONCE)
 *   PUT  /admin/clients/:id         action: approve|suspend|reject|regenerate-keys|update
 *   PUT  /admin/commission          set a client's versioned commission
 *   GET  /admin/transactions        global tx monitoring
 *   GET  /admin/payouts             paginated admin Payout list (optional status/clientId)
 *   POST /admin/payout              manually trigger a payout
 *   GET  /admin/webhook-logs        webhook delivery logs (panel)
 *   GET  /admin/wallets             on-chain balances (alias of /wallets/balances)
 *   GET  /admin/wallets/balances    on-chain balances of central/gas + client pending
 *   GET  /admin/analytics           volume / revenue / commission summary + timeseries
 *
 * API KEY SECRET STORAGE: see middleware/auth.ts. `api_secret_hash` holds the
 * envelope-ENCRYPTED raw secret (not a bcrypt hash) so HMAC verification can
 * recompute signatures. The plaintext secret is returned exactly once here.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { asyncHandler, AppError } from '../utils/apiError';
import { jwtAuth, requireRole } from '../middleware/jwtAuth';
import { query, queryOne, withTransaction } from '../db/pool';
import { encrypt, randomToken } from '../utils/crypto';
import { createApiKey } from '../services/apiKeyService';
import { setCommission } from '../services/commissionService';
import {
  getAllCommissionBalances,
  requestAdminWithdrawal,
  listWithdrawals,
} from '../services/adminCommissionService';
import { requestPayout } from '../services/payoutService';
import { writeAudit } from '../services/auditService';
import { allNetworkBalances } from '../blockchain/balance';
import { enabledNetworks, NETWORKS } from '../blockchain/networks';
import {
  getAdminClient,
  listAdminClients,
} from '../services/adminClientService';
import { mapPayoutStatusAdmin, mapPaymentStatus } from '../utils/statusMap';

const router = Router();

// TRC20 payout addresses are base58 `T…`. Validated by regex here (rather than
// via tronweb) so the admin API keeps working on a BEP20-only deployment where
// the Tron client is never loaded.
const TRON_WALLET_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;


// All admin routes require a valid JWT; role checks are per-route.
router.use(jwtAuth);

// ---------- helpers ----------

/**
 * Key minting lives in services/apiKeyService.ts — the admin path and the
 * merchant path (POST /account/api-keys) both call it, so prefixes, scopes and
 * storage format cannot drift between them. Admin-created keys are HMAC with
 * the full scope set, exactly as before this was extracted.
 */
async function insertApiKey(
  tx: PoolClient,
  clientId: string,
  label: string,
): Promise<{ apiKey: string; secret: string; apiKeyId: string }> {
  const created = await createApiKey({ clientId, label, authMode: 'hmac' }, tx);
  return { apiKey: created.apiKey, secret: created.secret, apiKeyId: created.id };
}

function parsePage(req: import('express').Request): { page: number; limit: number } {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)));
  return { page, limit };
}

// ---------- GET /admin/clients ----------
// Registered BEFORE '/clients/:id' so the list route is not shadowed.

router.get(
  '/clients',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePage(req);
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? req.query.status
        : undefined;
    const signupSource =
      req.query.signupSource === 'self' || req.query.signupSource === 'admin'
        ? req.query.signupSource
        : undefined;
    const result = await listAdminClients({ status, signupSource, page, limit });
    res.status(200).json(result);
  }),
);

// ---------- GET /admin/clients/:id ----------

router.get(
  '/clients/:id',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const client = await getAdminClient(req.params.id);
    if (!client) throw AppError.notFound('Client not found');
    res.status(200).json(client);
  }),
);

// ---------- POST /admin/clients ----------
// The admin panel sends { name, email, webhookUrl?, payoutWallet? } with NO
// password. Password is optional; when absent we generate a temp one.

const CreateClientSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8).optional(),
  webhookUrl: z.string().url().optional(),
  payoutWallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  // TRC20 settlement address (base58 T…). Optional and independent of the BEP20
  // one — a merchant may take payments on both chains, one, or neither.
  payoutWalletTrc20: z.string().regex(TRON_WALLET_RE).optional(),
  ipWhitelist: z.array(z.string()).optional(),
});

router.post(
  '/clients',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const body = CreateClientSchema.parse(req.body);
    const actor = req.user!;

    const temporaryPassword = body.password ?? randomToken(12);

    const result = await withTransaction(async (tx: PoolClient) => {
      const merchantRole = await tx.query<{ id: number }>(
        `SELECT id FROM roles WHERE name = 'merchant'`,
      );
      if (merchantRole.rowCount === 0) {
        throw AppError.internal('merchant role missing; run schema.sql');
      }

      const passwordHash = await bcrypt.hash(temporaryPassword, 12);
      let userId: string;
      try {
        // email_verified = true: an operator provisioned this account out of
        // band and hands over the credentials directly. There is no
        // verification link to click, so leaving it false (the column default,
        // which exists for self-registration) would strand the merchant.
        const userRes = await tx.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role_id, status, email_verified)
           VALUES ($1, $2, $3, 'active', true)
           RETURNING id`,
          [body.email, passwordHash, merchantRole.rows[0].id],
        );
        userId = userRes.rows[0].id;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw AppError.conflict('A user with that email already exists');
        }
        throw err;
      }

      const webhookSecretPlain = randomToken(24);

      const clientRes = await tx.query<{ id: string }>(
        `INSERT INTO clients
           (user_id, business_name, status, webhook_url, webhook_secret,
            payout_wallet, payout_wallet_trc20, ip_whitelist)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          userId,
          body.name,
          body.webhookUrl ?? null,
          encrypt(webhookSecretPlain),
          body.payoutWallet ?? null,
          body.payoutWalletTrc20 ?? null,
          body.ipWhitelist ?? [],
        ],
      );
      const clientId = clientRes.rows[0].id;

      const key = await insertApiKey(tx, clientId, 'default');

      await writeAudit(
        {
          actorUserId: actor.userId,
          action: 'client.create',
          entityType: 'client',
          entityId: clientId,
          metadata: { email: body.email, businessName: body.name },
          ip: req.ip,
        },
        tx,
      );

      return { clientId, key, webhookSecretPlain };
    });

    const client = await getAdminClient(result.clientId);
    // Secrets returned ONCE, merged into the admin Client shape.
    res.status(201).json({
      ...client,
      apiKey: result.key.apiKey,
      apiSecret: result.key.secret,
      webhookSecret: result.webhookSecretPlain,
      temporaryPassword,
    });
  }),
);

// ---------- PUT /admin/clients/:id ----------

const UpdateClientSchema = z.object({
  action: z.enum([
    'approve',
    'suspend',
    'reject',
    'regenerate-keys',
    'regenerate_keys',
    'set_password',
    'update',
  ]),
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(), // for action = set_password
  webhookUrl: z.string().url().optional(),
  payoutWallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  payoutWalletTrc20: z.string().regex(TRON_WALLET_RE).optional(),
  ipWhitelist: z.array(z.string()).optional(),
});

router.put(
  '/clients/:id',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const clientId = req.params.id;
    const body = UpdateClientSchema.parse(req.body);
    const actor = req.user!;

    const client = await queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM clients WHERE id = $1`,
      [clientId],
    );
    if (!client) throw AppError.notFound('Client not found');

    if (body.action === 'approve') {
      await query(
        `UPDATE clients
            SET status = 'approved', approved_by = $2, approved_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [clientId, actor.userId],
      );
      await writeAudit({
        actorUserId: actor.userId,
        action: 'client.approve',
        entityType: 'client',
        entityId: clientId,
        ip: req.ip,
      });
      res.status(200).json(await getAdminClient(clientId));
      return;
    }

    if (body.action === 'suspend' || body.action === 'reject') {
      const newStatus = body.action === 'suspend' ? 'suspended' : 'rejected';
      await query(
        `UPDATE clients SET status = $2, updated_at = now() WHERE id = $1`,
        [clientId, newStatus],
      );
      await writeAudit({
        actorUserId: actor.userId,
        action: `client.${body.action}`,
        entityType: 'client',
        entityId: clientId,
        ip: req.ip,
      });
      res.status(200).json(await getAdminClient(clientId));
      return;
    }

    if (body.action === 'set_password') {
      if (!body.password) {
        throw AppError.badRequest('password is required for set_password');
      }
      await withTransaction(async (tx: PoolClient) => {
        const userRow = await tx.query<{ user_id: string }>(
          `SELECT user_id FROM clients WHERE id = $1`,
          [clientId],
        );
        const uid = userRow.rows[0]?.user_id;
        if (!uid) throw AppError.notFound('Client user not found');
        const hash = await bcrypt.hash(body.password!, 12);
        await tx.query(
          `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
          [uid, hash],
        );
        await writeAudit(
          {
            actorUserId: actor.userId,
            action: 'client.set_password',
            entityType: 'client',
            entityId: clientId,
            ip: req.ip,
          },
          tx,
        );
      });
      res.status(200).json(await getAdminClient(clientId));
      return;
    }

    if (body.action === 'regenerate-keys' || body.action === 'regenerate_keys') {
      const result = await withTransaction(async (tx: PoolClient) => {
        await tx.query(
          `UPDATE api_keys SET status = 'revoked', revoked_at = now()
            WHERE client_id = $1 AND status = 'active'`,
          [clientId],
        );
        const key = await insertApiKey(tx, clientId, 'regenerated');
        await writeAudit(
          {
            actorUserId: actor.userId,
            action: 'client.regenerate_keys',
            entityType: 'client',
            entityId: clientId,
            ip: req.ip,
          },
          tx,
        );
        return key;
      });
      const updated = await getAdminClient(clientId);
      res.status(200).json({
        ...updated,
        apiKey: result.apiKey,
        apiSecret: result.secret,
      });
      return;
    }

    // action === 'update'
    await withTransaction(async (tx: PoolClient) => {
      if (body.email !== undefined) {
        const userRow = await tx.query<{ user_id: string }>(
          `SELECT user_id FROM clients WHERE id = $1`,
          [clientId],
        );
        if (userRow.rowCount && userRow.rowCount > 0) {
          try {
            await tx.query(`UPDATE users SET email = $2 WHERE id = $1`, [
              userRow.rows[0].user_id,
              body.email,
            ]);
          } catch (err) {
            if ((err as { code?: string }).code === '23505') {
              throw AppError.conflict('A user with that email already exists');
            }
            throw err;
          }
        }
      }
      await tx.query(
        `UPDATE clients
            SET business_name       = COALESCE($2, business_name),
                webhook_url         = COALESCE($3, webhook_url),
                payout_wallet       = COALESCE($4, payout_wallet),
                payout_wallet_trc20 = COALESCE($5, payout_wallet_trc20),
                ip_whitelist        = COALESCE($6, ip_whitelist),
                updated_at          = now()
          WHERE id = $1`,
        [
          clientId,
          body.name ?? null,
          body.webhookUrl ?? null,
          body.payoutWallet ?? null,
          body.payoutWalletTrc20 ?? null,
          body.ipWhitelist ?? null,
        ],
      );
      await writeAudit(
        {
          actorUserId: actor.userId,
          action: 'client.update',
          entityType: 'client',
          entityId: clientId,
          metadata: { fields: Object.keys(body).filter((k) => k !== 'action') },
          ip: req.ip,
        },
        tx,
      );
    });
    res.status(200).json(await getAdminClient(clientId));
  }),
);

// ---------- PUT /admin/commission ----------

const TierSchema = z.object({
  minAmount: z.string().min(1),
  maxAmount: z.string().min(1).nullable(), // null = unbounded (last tier)
  type: z.enum(['fixed', 'percentage']),
  value: z.string().min(1),
});

const CommissionSchema = z.object({
  clientId: z.string().uuid(),
  type: z.enum(['percentage', 'fixed', 'tiered']),
  value: z.string().optional(), // required for flat modes; ignored for tiered
  tiers: z.array(TierSchema).optional(), // required for tiered
  feePayer: z.enum(['client', 'admin']).default('client'),
  // Scope. Without these the operator can only ever write a commission that
  // means USDT (setCommission's default for an amount-denominated row), and on a
  // deployment where USDT is not what merchants settle in — a BTC-only gateway,
  // say — every fixed or tiered fee would be rejected at settlement with no way
  // to configure a usable one. `asset` is the denomination of the amounts in the
  // row; `network` optionally restricts it to one chain. Both are ignored for a
  // percentage rate, which has no denomination and applies to every asset.
  asset: z.string().min(1).optional(),
  network: z.string().min(1).optional(),
  note: z.string().optional(),
});

router.put(
  '/commission',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const body = CommissionSchema.parse(req.body);
    const actor = req.user!;
    await setCommission({
      clientId: body.clientId,
      type: body.type,
      value: body.value,
      tiers: body.tiers,
      networkFeePayer: body.feePayer,
      asset: body.asset,
      network: body.network,
      note: body.note ?? null,
      createdByUserId: actor.userId,
      ip: req.ip,
    });
    res.status(200).json(await getAdminClient(body.clientId));
  }),
);

// ---------- GET /admin/transactions ----------

router.get(
  '/transactions',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePage(req);
    const offset = (page - 1) * limit;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId : undefined;

    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (status) {
      args.push(status);
      where.push(`p.status = $${args.length}`);
    }
    if (clientId) {
      args.push(clientId);
      where.push(`p.client_id = $${args.length}`);
    }
    const whereSql = where.join(' AND ');

    const totalRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payments p WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRows[0]?.count ?? '0');

    const dataArgs = [...args, limit, offset];
    const rows = await query<{
      id: string;
      client_id: string;
      business_name: string;
      amount: string;
      amount_received: string;
      status: string;
      confirmations: number;
      tx_hash: string | null;
      deposit_address: string;
      network: string;
      created_at: string;
    }>(
      `SELECT p.id, p.client_id, c.business_name, p.amount,
              p.amount_received, p.status, p.confirmations, p.tx_hash,
              p.deposit_address, p.network, p.created_at
         FROM payments p
         JOIN clients c ON c.id = p.client_id
        WHERE ${whereSql}
        ORDER BY p.created_at DESC
        LIMIT $${dataArgs.length - 1} OFFSET $${dataArgs.length}`,
      dataArgs,
    );

    const data = rows.map((r) => ({
      id: r.id,
      paymentId: r.id,
      clientId: r.client_id,
      clientName: r.business_name,
      type: 'deposit',
      status: mapPaymentStatus(r.status),
      amount: Number(r.amount_received) > 0 ? r.amount_received : r.amount,
      currency: 'USDT',
      network: r.network,
      fromAddress: null,
      toAddress: r.deposit_address,
      txHash: r.tx_hash,
      confirmations: r.confirmations,
      createdAt: new Date(r.created_at).toISOString(),
    }));

    res.status(200).json({ data, page, total });
  }),
);

// ---------- GET /admin/payouts ----------

router.get(
  '/payouts',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePage(req);
    const offset = (page - 1) * limit;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId : undefined;

    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (status) {
      args.push(status);
      where.push(`po.status = $${args.length}`);
    }
    if (clientId) {
      args.push(clientId);
      where.push(`po.client_id = $${args.length}`);
    }
    const whereSql = where.join(' AND ');

    const totalRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payouts po WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRows[0]?.count ?? '0');

    const dataArgs = [...args, limit, offset];
    const rows = await query<{
      id: string;
      client_id: string;
      business_name: string;
      gross_amount: string;
      status: string;
      to_address: string;
      network: string;
      tx_hash: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT po.id, po.client_id, c.business_name, po.gross_amount, po.status,
              po.to_address, po.network, po.tx_hash, po.created_at, po.updated_at
         FROM payouts po
         JOIN clients c ON c.id = po.client_id
        WHERE ${whereSql}
        ORDER BY po.created_at DESC
        LIMIT $${dataArgs.length - 1} OFFSET $${dataArgs.length}`,
      dataArgs,
    );

    const data = rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientName: r.business_name,
      amount: r.gross_amount,
      currency: 'USDT',
      // Which chain this payout settles on — decides the explorer link and
      // which hot wallet actually funded it.
      network: r.network,
      status: mapPayoutStatusAdmin(r.status),
      toAddress: r.to_address,
      txHash: r.tx_hash,
      createdAt: new Date(r.created_at).toISOString(),
      completedAt:
        r.status === 'sent' || r.status === 'confirmed'
          ? new Date(r.updated_at).toISOString()
          : null,
    }));

    res.status(200).json({ data, page, total });
  }),
);

// ---------- POST /admin/payout ----------

const AdminPayoutSchema = z.object({
  clientId: z.string().uuid(),
  amount: z.string().min(1),
  note: z.string().optional(),
  paymentId: z.string().optional(),
  estimatedNetworkFee: z.string().optional(),
  // Which chain to settle on. Omitted -> BEP20, so existing admin tooling is
  // unchanged. requestPayout rejects TRC20 when Tron is off or the merchant has
  // no payout_wallet_trc20, and enforces the per-network balance guard.
  network: z.string().optional(),
});

router.post(
  '/payout',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const body = AdminPayoutSchema.parse(req.body);
    const actor = req.user!;
    const payout = await requestPayout({
      clientId: body.clientId,
      amount: body.amount,
      paymentId: body.paymentId ?? null,
      network: body.network,
      type: 'manual',
      triggeredByUserId: actor.userId,
      estimatedNetworkFee: body.estimatedNetworkFee,
      ip: req.ip,
    });
    if (body.note) {
      await writeAudit({
        actorUserId: actor.userId,
        action: 'payout.note',
        entityType: 'payout',
        entityId: payout.id,
        metadata: { note: body.note },
        ip: req.ip,
      });
    }
    res.status(202).json({
      payoutId: payout.id,
      netAmount: payout.net_amount,
      commissionAmount: payout.commission_amount,
      // admin Payout shape fields where cheap:
      id: payout.id,
      clientId: payout.client_id,
      amount: payout.gross_amount,
      currency: 'USDT',
      status: mapPayoutStatusAdmin(payout.status),
      toAddress: payout.to_address,
      txHash: payout.tx_hash,
      createdAt: new Date(payout.created_at).toISOString(),
      completedAt: null,
    });
  }),
);

// ---------- GET /admin/webhook-logs ----------

router.get(
  '/webhook-logs',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePage(req);
    const offset = (page - 1) * limit;
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId : undefined;

    const where: string[] = ['1=1'];
    const args: unknown[] = [];
    if (clientId) {
      args.push(clientId);
      where.push(`client_id = $${args.length}`);
    }
    const whereSql = where.join(' AND ');

    const totalRows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_logs WHERE ${whereSql}`,
      args,
    );
    const total = Number(totalRows[0]?.count ?? '0');

    const dataArgs = [...args, limit, offset];
    const rows = await query(
      `SELECT id, client_id, payment_id, event, url, attempt, status_code,
              success, next_retry_at, created_at
         FROM webhook_logs
        WHERE ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${dataArgs.length - 1} OFFSET $${dataArgs.length}`,
      dataArgs,
    );
    res.status(200).json({ data: rows, page, total });
  }),
);

// ---------- GET /admin/wallets  &  /admin/wallets/balances ----------

async function walletBalancesHandler(
  _req: import('express').Request,
  res: import('express').Response,
): Promise<void> {
  // Per-chain central + gas positions for every ENABLED network. On a
  // BEP20-only deployment this is a one-element array and the payload below is
  // equivalent to what it always was.
  const networks = await allNetworkBalances();
  const bep20 = networks.find((n) => n.network === 'BEP20');

  // Client pending is per-network too: a merchant can have funds in flight on
  // both chains at once, and a single summed figure would hide which chain owes
  // them (and therefore which hot wallet has to cover it).
  const pendingRows = await query<{
    client_id: string;
    business_name: string;
    network: string;
    pending: string;
  }>(
    `SELECT c.id AS client_id, c.business_name, p.network,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('waiting','confirming')),0)::text AS pending
       FROM clients c
       JOIN payments p ON p.client_id = c.id
      GROUP BY c.id, c.business_name, p.network
      HAVING COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('waiting','confirming')),0) > 0
      ORDER BY pending DESC`,
  );

  res.status(200).json({
    networks,
    // ---- Back-compat aliases (BEP20 only) --------------------------------
    // The pre-multi-network admin panel reads `central`/`gas` with a `bnb`
    // field. Keeping them means an older panel build served during a rolling
    // deploy still renders instead of showing an empty page.
    central: {
      address: bep20?.central.address ?? '',
      label: 'Central',
      usdt: bep20?.central.usdt ?? '0',
      bnb: bep20?.central.native ?? '0',
    },
    gas: {
      address: bep20?.gas.address ?? '',
      label: 'Gas station',
      usdt: bep20?.gas.usdt ?? '0',
      bnb: bep20?.gas.native ?? '0',
    },
    clientPending: pendingRows.map((r) => ({
      clientId: r.client_id,
      clientName: r.business_name,
      network: r.network,
      pending: r.pending,
      available: '0',
    })),
  });
}

router.get(
  '/wallets',
  requireRole('super_admin', 'ops'),
  asyncHandler(walletBalancesHandler),
);
router.get(
  '/wallets/balances',
  requireRole('super_admin', 'ops'),
  asyncHandler(walletBalancesHandler),
);

// ---------- GET /admin/analytics ----------

router.get(
  '/analytics',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (_req, res) => {
    const totals = await queryOne<{
      total_volume: string;
      today_revenue: string;
      total_revenue: string;
      total_commission: string;
      active_clients: string;
      pending_payouts: string;
      pending_payout_amount: string;
    }>(
      `SELECT
         (SELECT COALESCE(SUM(amount_received),0) FROM payments
            WHERE status IN ('confirmed','swept'))::text AS total_volume,
         (SELECT COALESCE(SUM(commission_amount),0) FROM payouts
            WHERE created_at >= date_trunc('day', now()))::text AS today_revenue,
         (SELECT COALESCE(SUM(net_amount),0) FROM payouts
            WHERE status IN ('sent','confirmed'))::text AS total_revenue,
         (SELECT COALESCE(SUM(commission_amount),0) FROM payouts)::text AS total_commission,
         (SELECT COUNT(*) FROM clients WHERE status = 'approved')::text AS active_clients,
         (SELECT COUNT(*) FROM payouts WHERE status IN ('pending','processing'))::text AS pending_payouts,
         (SELECT COALESCE(SUM(gross_amount),0) FROM payouts
            WHERE status IN ('pending','processing'))::text AS pending_payout_amount`,
    );

    // Day axis via generate_series so empty days are 0.
    const timeseries = await query<{
      date: string;
      volume: string;
      revenue: string;
      commission: string;
      count: string;
    }>(
      `WITH days AS (
         SELECT generate_series(
                  date_trunc('day', now()) - interval '29 days',
                  date_trunc('day', now()),
                  interval '1 day'
                ) AS d
       ),
       pay AS (
         SELECT date_trunc('day', created_at) AS d,
                COALESCE(SUM(amount_received),0) AS volume,
                COUNT(*) AS cnt
           FROM payments
          WHERE status IN ('confirmed','swept')
            AND created_at >= date_trunc('day', now()) - interval '29 days'
          GROUP BY 1
       ),
       po AS (
         SELECT date_trunc('day', created_at) AS d,
                COALESCE(SUM(commission_amount),0) AS revenue,
                COALESCE(SUM(commission_amount),0) AS commission
           FROM payouts
          WHERE created_at >= date_trunc('day', now()) - interval '29 days'
          GROUP BY 1
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
              COALESCE(pay.volume,0)::text AS volume,
              COALESCE(po.revenue,0)::text AS revenue,
              COALESCE(po.commission,0)::text AS commission,
              COALESCE(pay.cnt,0)::text AS count
         FROM days
         LEFT JOIN pay ON pay.d = days.d
         LEFT JOIN po  ON po.d  = days.d
        ORDER BY days.d ASC`,
    );

    const breakdown = await query<{
      client_id: string;
      business_name: string;
      volume: string;
      commission: string;
    }>(
      `SELECT c.id AS client_id, c.business_name,
              COALESCE(v.volume,0)::text AS volume,
              COALESCE(cm.commission,0)::text AS commission
         FROM clients c
         LEFT JOIN (
           SELECT client_id, SUM(amount_received) AS volume
             FROM payments WHERE status IN ('confirmed','swept')
            GROUP BY client_id
         ) v ON v.client_id = c.id
         LEFT JOIN (
           SELECT client_id, SUM(commission_amount) AS commission
             FROM payouts GROUP BY client_id
         ) cm ON cm.client_id = c.id
        ORDER BY COALESCE(v.volume,0) DESC
        LIMIT 10`,
    );

    // Per-network split. The aggregates above deliberately stay chain-agnostic
    // (total business volume is one number), but an operator also needs to know
    // WHICH chain the volume landed on — that decides which hot wallet has to be
    // funded and which one is accumulating. Payment volume and payout
    // commission are counted separately because they key off different tables.
    const byNetwork = await query<{
      network: string;
      volume: string;
      count: string;
      commission: string;
    }>(
      `SELECT n.network,
              COALESCE(v.volume,0)::text     AS volume,
              COALESCE(v.cnt,0)::text        AS count,
              COALESCE(cm.commission,0)::text AS commission
         FROM (SELECT unnest($1::text[]) AS network) n
         LEFT JOIN (
           SELECT network, SUM(amount_received) AS volume, COUNT(*) AS cnt
             FROM payments WHERE status IN ('confirmed','swept')
            GROUP BY network
         ) v ON v.network = n.network
         LEFT JOIN (
           SELECT network, SUM(commission_amount) AS commission
             FROM payouts GROUP BY network
         ) cm ON cm.network = n.network
        ORDER BY COALESCE(v.volume,0) DESC`,
      [NETWORKS as unknown as string[]],
    );

    res.status(200).json({
      totalVolume: totals?.total_volume ?? '0',
      todayRevenue: totals?.today_revenue ?? '0',
      totalRevenue: totals?.total_revenue ?? '0',
      totalCommission: totals?.total_commission ?? '0',
      activeClients: Number(totals?.active_clients ?? 0),
      pendingPayouts: Number(totals?.pending_payouts ?? 0),
      pendingPayoutAmount: totals?.pending_payout_amount ?? '0',
      networkBreakdown: byNetwork.map((n) => ({
        network: n.network,
        volume: Number(n.volume),
        count: Number(n.count),
        commission: Number(n.commission),
        enabled: (enabledNetworks() as string[]).includes(n.network),
      })),
      timeseries: timeseries.map((t) => ({
        date: t.date,
        volume: Number(t.volume),
        revenue: Number(t.revenue),
        commission: Number(t.commission),
        count: Number(t.count),
      })),
      clientBreakdown: breakdown.map((b) => ({
        clientId: b.client_id,
        clientName: b.business_name,
        volume: Number(b.volume),
        commission: Number(b.commission),
      })),
    });
  }),
);

// ---------- Admin commission (accrual + withdrawal) ----------

// GET /admin/commission-balance -> accrued / withdrawn / available (USDT)
//
// Commission is held per chain (see adminCommissionService), so the real answer
// is one figure PER network. The top-level fields stay BEP20 for back-compat
// with the existing panel; `networks` carries the full picture.
router.get(
  '/commission-balance',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (_req, res) => {
    const balances = await getAllCommissionBalances();
    const bep20 = balances.find((b) => b.network === 'BEP20');
    res.status(200).json({
      ...(bep20 ?? {
        network: 'BEP20',
        accrued: '0',
        withdrawn: '0',
        available: '0',
        currency: 'USDT',
      }),
      networks: balances,
    });
  }),
);

// POST /admin/commission-withdraw -> withdraw accrued commission to an address
//
// The address format differs per chain, so it is validated against the target
// network rather than by a single regex — see requestAdminWithdrawal, which
// checks it via the chain adapter and rejects a cross-chain paste.
const WithdrawSchema = z.object({
  amount: z.string().min(1),
  toAddress: z.string().min(1),
  network: z.string().optional(),
  // The commission pool is per (network, ASSET) — a BNB accrual is not spendable
  // as USDT. Without this field the balance screen could show BNB, USDC and BTC
  // commission that no request could ever draw on, because the service falls
  // back to the chain's default asset. Omitted still means that default, which
  // is what every withdrawal made before the pool was split silently was.
  asset: z.string().optional(),
});
router.post(
  '/commission-withdraw',
  requireRole('super_admin'),
  asyncHandler(async (req, res) => {
    const body = WithdrawSchema.parse(req.body);
    const actor = req.user!;
    const w = await requestAdminWithdrawal({
      amount: body.amount,
      toAddress: body.toAddress,
      network: body.network,
      asset: body.asset,
      triggeredByUserId: actor.userId,
      ip: req.ip,
    });
    res.status(202).json({
      id: w.id,
      amount: w.amount,
      toAddress: w.to_address,
      network: w.network,
      // Echoed back because the pool is per (network, asset): a response that
      // names only the chain does not say what was actually withdrawn.
      asset: w.asset,
      status: w.status,
    });
  }),
);

// GET /admin/commission-withdrawals -> withdrawal history
router.get(
  '/commission-withdrawals',
  requireRole('super_admin', 'ops'),
  asyncHandler(async (_req, res) => {
    const rows = await listWithdrawals(50);
    res.status(200).json({
      data: rows.map((r) => ({
        id: r.id,
        amount: r.amount,
        toAddress: r.to_address,
        network: r.network,
        // History that names only the chain is unreadable now that a chain holds
        // several pools: two rows for BEP20 could be USDT and BNB, and a failed
        // one would show an error with nothing to attribute it to.
        asset: r.asset,
        txHash: r.tx_hash,
        status: r.status,
        error: r.error,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    });
  }),
);

export default router;
