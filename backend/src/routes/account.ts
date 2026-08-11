/**
 * Merchant account routes (client-panel; `clientAuth` — JWT merchant or API key).
 *
 *   GET    /balance                      available/pending balance in USDT
 *   GET    /account/api-keys             list keys (never a secret)
 *   GET    /account/api-keys/primary     legacy single-key shape (SDK docs)
 *   POST   /account/api-keys             create a key; secret shown ONCE
 *   DELETE /account/api-keys/:id         revoke a key
 *   POST   /account/api-keys/regenerate  legacy rotate-the-one-key
 *   GET    /account/settings             webhook/payout settings
 *   PUT    /account/settings             update webhook/payout settings
 *   GET    /account/onboarding           get-started checklist state
 *   GET    /account/commission           active commission (client-panel shape)
 *   GET    /account/webhook-logs         recent webhook deliveries
 *
 * All routes resolve the client from `req.client.clientId`.
 *
 * ============================ AUTH SPLIT (important) =========================
 * Reads accept either credential. Everything that MUTATES the account's security
 * posture — the payout wallet, the set of API keys, the password, the IP
 * allowlist — additionally requires `requireDashboardSession`, i.e. a signed-in
 * human, never an API key. See the note on that guard in middleware/clientAuth.ts
 * for why: an API key that can change where settlements are paid turns a leaked
 * credential into a direct loss.
 */
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { asyncHandler, AppError } from '../utils/apiError';
import { clientAuth, requireDashboardSession } from '../middleware/clientAuth';
import { getAllBalances, getBalance } from '../services/payoutService';
import { parseNetwork } from '../blockchain/networks';
import { query, queryOne, withTransaction } from '../db/pool';
import { encrypt, randomToken } from '../utils/crypto';
import { writeAudit } from '../services/auditService';
import { config } from '../config/env';
import {
  ALL_SCOPES,
  AuthMode,
  Scope,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../services/apiKeyService';
import { sendApiKeyCreatedEmail } from '../services/emailService';
import {
  claimForSweep,
  listUnexpectedDeposits,
  markFailed,
  markSwept,
} from '../services/unexpectedDepositService';
import { adapterFor } from '../blockchain/networks';

const router = Router();

// BEP20 payout wallet is an EVM 0x address. TRC20 is a base58 T… address; it is
// validated by the Tron adapter (tronweb) rather than a loose regex.
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const TRON_WALLET_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

// ---------- GET /balance ----------

// Two shapes, deliberately:
//   GET /balance                    -> the legacy single object (all networks,
//                                      all assets, labelled USDT). Unchanged for
//                                      every integration written before assets.
//   GET /balance?network=&asset=    -> that one balance, same object shape.
//   GET /balance?all=true           -> an ARRAY, one entry per (network, asset).
//
// The array is opt-in rather than the default precisely because changing the
// default response type would silently break every existing client.
router.get(
  '/balance',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;

    if (req.query.all === 'true') {
      res.status(200).json(await getAllBalances(client.clientId));
      return;
    }

    const network =
      typeof req.query.network === 'string' && req.query.network
        ? parseNetwork(req.query.network)
        : undefined;
    const asset =
      typeof req.query.asset === 'string' && req.query.asset
        ? req.query.asset.toUpperCase()
        : undefined;

    const balance = await getBalance(client.clientId, network, asset);
    res.status(200).json(balance);
  }),
);

// ---------- GET /account/api-keys ----------
// Returns an ARRAY. The pre-multi-key single-object shape lives on at
// /account/api-keys/primary so the published SDK examples keep working.

router.get(
  '/account/api-keys',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const includeRevoked = req.query.includeRevoked === 'true';
    res.status(200).json(await listApiKeys(client.clientId, includeRevoked));
  }),
);

// ---------- GET /account/api-keys/primary ----------
// Legacy shape: the newest active key as a bare object.

router.get(
  '/account/api-keys/primary',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const keys = await listApiKeys(client.clientId);
    const primary = keys[0];
    res.status(200).json({
      apiKey: primary?.apiKey ?? '',
      createdAt: primary?.createdAt ?? '',
      lastUsedAt: primary?.lastUsedAt ?? null,
    });
  }),
);

// ---------- POST /account/api-keys ----------

const CreateKeySchema = z.object({
  label: z.string().min(1).max(60).default('default'),
  authMode: z.enum(['hmac', 'simple']).default('hmac'),
  scopes: z.array(z.enum(ALL_SCOPES as [Scope, ...Scope[]])).optional(),
});

router.post(
  '/account/api-keys',
  clientAuth,
  requireDashboardSession,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const body = CreateKeySchema.parse(req.body ?? {});

    // A cap, not a policy: unbounded key creation is a way to bury a malicious
    // key in a long list where nobody notices it.
    const existing = await listApiKeys(client.clientId);
    if (existing.length >= 10) {
      throw AppError.badRequest(
        'You already have 10 active API keys. Revoke one before creating another.',
      );
    }

    // createApiKey rejects payouts:write on a simple key (see apiKeyService).
    const created = await createApiKey({
      clientId: client.clientId,
      label: body.label,
      authMode: body.authMode as AuthMode,
      scopes: body.scopes,
    });

    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'client.api_key_create',
      entityType: 'client',
      entityId: client.clientId,
      metadata: {
        apiKeyId: created.id,
        authMode: created.authMode,
        scopes: created.scopes,
        label: body.label,
      },
      ip: req.ip,
    });

    // Security notice to the account owner — a new key is a new credential
    // against their balance. Best-effort; never blocks the response.
    if (req.user?.email) {
      void sendApiKeyCreatedEmail({
        to: req.user.email,
        label: body.label,
        maskedKey: created.apiKey,
        authMode: created.authMode,
      }).catch(() => undefined);
    }

    await refreshOnboardingState(client.clientId);

    // The secret is in this response and nowhere else, ever again.
    res.status(201).json({
      id: created.id,
      apiKey: created.apiKey,
      apiSecret: created.secret,
      authMode: created.authMode,
      scopes: created.scopes,
      createdAt: created.createdAt,
    });
  }),
);

// ---------- DELETE /account/api-keys/:id ----------

router.delete(
  '/account/api-keys/:id',
  clientAuth,
  requireDashboardSession,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const ok = await revokeApiKey(client.clientId, req.params.id);
    if (!ok) throw AppError.notFound('API key not found or already revoked');

    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'client.api_key_revoke',
      entityType: 'client',
      entityId: client.clientId,
      metadata: { apiKeyId: req.params.id },
      ip: req.ip,
    });
    res.status(200).json({ success: true });
  }),
);

// ---------- POST /account/api-keys/regenerate ----------
// Legacy: revoke every active key and mint one fresh HMAC key. Kept because it
// is what docs/merchant-onboarding.md and the SDK guides describe.

router.post(
  '/account/api-keys/regenerate',
  clientAuth,
  requireDashboardSession,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const result = await withTransaction(async (tx: PoolClient) => {
      await tx.query(
        `UPDATE api_keys SET status = 'revoked', revoked_at = now()
          WHERE client_id = $1 AND status = 'active'`,
        [client.clientId],
      );
      const apiKey = `pk_live_${randomToken(12)}`;
      const secret = `sk_live_${randomToken(24)}`;
      const inserted = await tx.query<{ created_at: string }>(
        `INSERT INTO api_keys
           (client_id, api_key, api_secret_hash, label, status, auth_mode)
         VALUES ($1, $2, $3, 'regenerated', 'active', 'hmac')
         RETURNING created_at`,
        [client.clientId, apiKey, encrypt(secret)],
      );
      await writeAudit(
        {
          actorUserId: req.user?.userId ?? null,
          actorType: 'user',
          action: 'client.regenerate_keys',
          entityType: 'client',
          entityId: client.clientId,
          ip: req.ip,
        },
        tx,
      );
      return { apiKey, secret, createdAt: inserted.rows[0].created_at };
    });

    res.status(200).json({
      apiKey: result.apiKey,
      apiSecret: result.secret,
      createdAt: new Date(result.createdAt).toISOString(),
    });
  }),
);

// ---------- GET /account/settings ----------

interface SettingsRow {
  webhook_url: string | null;
  payout_wallet: string | null;
  payout_wallet_trc20: string | null;
  payout_wallet_erc20: string | null;
  payout_wallet_btc: string | null;
  ip_whitelist: string[] | null;
  has_secret: boolean;
}

function toSettings(row: SettingsRow | null) {
  return {
    webhookUrl: row?.webhook_url ?? null,
    payoutWallet: row?.payout_wallet ?? null,
    payoutWalletTrc20: row?.payout_wallet_trc20 ?? null,
    // Separate from payoutWallet despite both being 0x addresses — the two EVM
    // chains share an address FORMAT, not a destination. See payoutService.
    payoutWalletErc20: row?.payout_wallet_erc20 ?? null,
    payoutWalletBtc: row?.payout_wallet_btc ?? null,
    ipWhitelist: row?.ip_whitelist ?? [],
    webhookSecretSet: row?.has_secret ?? false,
  };
}

router.get(
  '/account/settings',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const row = await queryOne<SettingsRow>(
      `SELECT webhook_url, payout_wallet, payout_wallet_trc20, payout_wallet_erc20,
              payout_wallet_btc, ip_whitelist,
              (webhook_secret IS NOT NULL) AS has_secret
         FROM clients WHERE id = $1`,
      [client.clientId],
    );
    res.status(200).json(toSettings(row));
  }),
);

// ---------- PUT /account/settings ----------
// DASHBOARD SESSION ONLY. This writes the payout wallet — the address every
// settlement is sent to — so an API key must not be able to reach it.

const SettingsSchema = z.object({
  webhookUrl: z.string().url().nullable().optional(),
  payoutWallet: z.string().regex(WALLET_RE, 'invalid BEP20 address').nullable().optional(),
  payoutWalletTrc20: z
    .string()
    .regex(TRON_WALLET_RE, 'invalid TRC20 (Tron) address')
    .nullable()
    .optional(),
  payoutWalletErc20: z
    .string()
    .regex(WALLET_RE, 'invalid ERC20 (Ethereum) address')
    .nullable()
    .optional(),
  // Bitcoin addresses come in several shapes (bech32 bc1…/tb1…, legacy 1…/3…),
  // so this is a loose length/charset check here and a real, network-aware
  // validation in the adapter — which is the only place that knows whether this
  // deployment is on mainnet or testnet.
  payoutWalletBtc: z.string().min(14).max(90).nullable().optional(),
  // Empty array = no IP restriction (the default). Non-empty is enforced on
  // every API request by middleware/auth.ts.
  ipWhitelist: z.array(z.string().min(3).max(45)).max(50).optional(),
});

router.put(
  '/account/settings',
  clientAuth,
  requireDashboardSession,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const body = SettingsSchema.parse(req.body);

    const row = await queryOne<SettingsRow>(
      `UPDATE clients
          SET webhook_url         = COALESCE($2, webhook_url),
              payout_wallet       = COALESCE($3, payout_wallet),
              payout_wallet_trc20 = COALESCE($4, payout_wallet_trc20),
              payout_wallet_erc20 = COALESCE($6, payout_wallet_erc20),
              payout_wallet_btc   = COALESCE($7, payout_wallet_btc),
              -- $5 IS NULL means "not supplied"; an empty array is a real value
              -- (clear the allowlist) and must not be confused with it.
              ip_whitelist        = COALESCE($5::text[], ip_whitelist),
              updated_at          = now()
        WHERE id = $1
        RETURNING webhook_url, payout_wallet, payout_wallet_trc20,
                  payout_wallet_erc20, payout_wallet_btc, ip_whitelist,
                  (webhook_secret IS NOT NULL) AS has_secret`,
      [
        client.clientId,
        body.webhookUrl ?? null,
        body.payoutWallet ?? null,
        body.payoutWalletTrc20 ?? null,
        body.ipWhitelist ? body.ipWhitelist.map((s) => s.trim()) : null,
        body.payoutWalletErc20 ?? null,
        body.payoutWalletBtc ?? null,
      ],
    );
    await writeAudit({
      actorUserId: req.user?.userId ?? null,
      actorType: 'user',
      action: 'client.settings_update',
      entityType: 'client',
      entityId: client.clientId,
      metadata: { fields: Object.keys(body) },
      ip: req.ip,
    });
    await refreshOnboardingState(client.clientId);
    res.status(200).json(toSettings(row));
  }),
);

// ---------- GET /account/commission ----------

router.get(
  '/account/commission',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const row = await queryOne<{
      type: string;
      value: string;
      tiers: unknown;
      network_fee_payer: string;
      asset: string | null;
      created_at: string;
    }>(
      `SELECT type, value, tiers, network_fee_payer, asset, created_at
         FROM commissions
        WHERE client_id = $1 AND is_active = true
        ORDER BY created_at DESC
        LIMIT 1`,
      [client.clientId],
    );

    if (!row) {
      res.status(200).json({
        type: 'percentage',
        percent: '0',
        networkFeePaidBy: 'client',
        currency: 'USDT',
        effectiveFrom: new Date(0).toISOString(),
      });
      return;
    }

    const isPercentage = row.type === 'percentage';
    const isTiered = row.type === 'tiered';
    res.status(200).json({
      type: row.type, // 'percentage' | 'fixed' | 'tiered'
      percent: isPercentage ? row.value : '0',
      ...(isPercentage || isTiered ? {} : { fixedFee: row.value }),
      ...(isTiered ? { tiers: row.tiers ?? [] } : {}),
      networkFeePaidBy: row.network_fee_payer,
      // The denomination the fee is actually written in, not a hardcoded 'USDT'.
      // A fixed or tiered commission carries amounts and those amounts belong to
      // one asset; telling a merchant on a BTC-denominated fee that it is in
      // USDT is the same mistake that let the number be applied to whatever
      // asset arrived. A percentage rate has no denomination — it applies to
      // every asset — so it keeps reporting USDT, which is what this field has
      // always meant for a percent and what the panel renders alongside it.
      currency: isPercentage ? 'USDT' : (row.asset ?? 'USDT'),
      effectiveFrom: new Date(row.created_at).toISOString(),
    });
  }),
);

// ---------- POST /account/change-password ----------

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post(
  '/account/change-password',
  clientAuth,
  requireDashboardSession,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);

    const row = await queryOne<{ id: string; password_hash: string }>(
      `SELECT u.id, u.password_hash
         FROM clients c JOIN users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [client.clientId],
    );
    if (!row) throw AppError.notFound('Account not found');

    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) throw AppError.unauthorized('Current password is incorrect');

    const hash = await bcrypt.hash(newPassword, 12);
    await query(
      `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
      [row.id, hash],
    );
    await writeAudit({
      actorUserId: row.id,
      actorType: 'user',
      action: 'account.change_password',
      entityType: 'user',
      entityId: row.id,
      ip: req.ip,
    });
    res.status(200).json({ success: true });
  }),
);

// ---------- GET /account/onboarding ----------
// Drives the get-started checklist. Every step is DERIVED from real state rather
// than a stored flag, so it stays honest if a merchant later clears their
// webhook URL or revokes their last key.
//
// Step order mirrors what the payout path actually requires: a wallet must exist
// before a key is worth having, because a key with nowhere to settle produces
// confirmed payments that can never be paid out.

interface OnboardingRow {
  email_verified: boolean;
  payout_wallet: string | null;
  payout_wallet_trc20: string | null;
  payout_wallet_erc20: string | null;
  payout_wallet_btc: string | null;
  webhook_url: string | null;
  ip_whitelist: string[] | null;
  active_keys: string;
  simple_keys: string;
  payments: string;
  onboarding_completed_at: string | null;
}

const ONBOARDING_SELECT = `
  SELECT u.email_verified,
         c.payout_wallet,
         c.payout_wallet_trc20,
         c.payout_wallet_erc20,
         c.payout_wallet_btc,
         c.webhook_url,
         c.ip_whitelist,
         c.onboarding_completed_at,
         (SELECT COUNT(*) FROM api_keys k
           WHERE k.client_id = c.id AND k.status = 'active')::text AS active_keys,
         (SELECT COUNT(*) FROM api_keys k
           WHERE k.client_id = c.id AND k.status = 'active'
             AND k.auth_mode = 'simple')::text AS simple_keys,
         (SELECT COUNT(*) FROM payments p
           WHERE p.client_id = c.id)::text AS payments
    FROM clients c
    JOIN users u ON u.id = c.user_id
   WHERE c.id = $1
`;

/**
 * Stamp `onboarding_completed_at` the first time all required steps are done.
 * Called opportunistically after the mutations that can complete a step; never
 * throws, because failing to update a UI flag must not fail the real write.
 */
async function refreshOnboardingState(clientId: string): Promise<void> {
  try {
    await query(
      `UPDATE clients c
          SET onboarding_completed_at = now()
        WHERE c.id = $1
          AND c.onboarding_completed_at IS NULL
          AND (c.payout_wallet IS NOT NULL OR c.payout_wallet_trc20 IS NOT NULL
               OR c.payout_wallet_erc20 IS NOT NULL
               OR c.payout_wallet_btc IS NOT NULL)
          AND c.webhook_url IS NOT NULL
          AND EXISTS (SELECT 1 FROM api_keys k
                       WHERE k.client_id = c.id AND k.status = 'active')`,
      [clientId],
    );
  } catch {
    // Cosmetic only.
  }
}

router.get(
  '/account/onboarding',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const row = await queryOne<OnboardingRow>(ONBOARDING_SELECT, [client.clientId]);
    if (!row) throw AppError.notFound('Account not found');

    const hasWallet = Boolean(
      row.payout_wallet ||
        row.payout_wallet_trc20 ||
        row.payout_wallet_erc20 ||
        row.payout_wallet_btc,
    );
    const hasKey = Number(row.active_keys) > 0;
    const hasWebhook = Boolean(row.webhook_url);
    const hasPayment = Number(row.payments) > 0;

    const steps = [
      {
        id: 'verify_email',
        title: 'Verify your email',
        description: 'Confirms the address we send account and security notices to.',
        done: row.email_verified,
        href: null,
        required: true,
      },
      {
        id: 'payout_wallet',
        title: 'Add a settlement wallet',
        description:
          'Where your USDT is paid out. Set this before creating a key — a key ' +
          'with nowhere to settle collects payments you cannot withdraw.',
        done: hasWallet,
        href: '/settings',
        required: true,
      },
      {
        id: 'api_key',
        title: 'Create an API key',
        description: 'The credential your server uses to create payments.',
        done: hasKey,
        href: '/api-keys',
        required: true,
      },
      {
        id: 'webhook',
        title: 'Set your webhook URL',
        description:
          'We POST a signed notification here the moment a payment confirms.',
        done: hasWebhook,
        href: '/settings',
        required: true,
      },
      {
        id: 'first_payment',
        title: 'Take your first payment',
        description: 'Create one from the dashboard to see the whole flow end to end.',
        done: hasPayment,
        href: '/payments/new',
        required: false,
      },
    ];

    const requiredDone = steps.filter((s) => s.required && s.done).length;
    const requiredTotal = steps.filter((s) => s.required).length;

    if (requiredDone === requiredTotal && !row.onboarding_completed_at) {
      await refreshOnboardingState(client.clientId);
    }

    res.status(200).json({
      steps,
      complete: requiredDone === requiredTotal,
      completedRequired: requiredDone,
      totalRequired: requiredTotal,
      // Surfaced so the panel can warn: a bearer-token key with no IP allowlist
      // is the weakest supported configuration.
      warnings: {
        simpleKeyWithoutIpAllowlist:
          Number(row.simple_keys) > 0 && (row.ip_whitelist ?? []).length === 0,
      },
    });
  }),
);

// ---------- Unexpected deposits (wrong-asset / late payments) ----------
// Funds that arrived at one of this merchant's deposit addresses but could not
// be credited to a payment. Read is dual-auth; RECOVERY moves money on-chain and
// is therefore a dashboard-session action, like every other money-moving control.

router.get(
  '/account/unexpected-deposits',
  clientAuth,
  asyncHandler(async (req, res) => {
    res.status(200).json(await listUnexpectedDeposits(req.client!.clientId));
  }),
);

router.post(
  '/account/unexpected-deposits/:id/recover',
  clientAuth,
  requireDashboardSession,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    // The status transition IS the lock: only a row in 'detected' or 'failed'
    // can be claimed, so two clicks cannot sweep the same address twice.
    const row = await claimForSweep(req.params.id, client.clientId);
    if (!row) {
      throw AppError.badRequest(
        'This deposit is already being recovered, or has been recovered.',
      );
    }

    if (row.derivation_index === null) {
      await markFailed(row.id, 'No derivation index recorded for this address');
      throw AppError.badRequest(
        'This deposit cannot be recovered automatically — no derivation index was ' +
          'recorded. Contact support with the transaction hash.',
      );
    }

    try {
      const network = parseNetwork(row.network);
      const adapter = adapterFor(network);
      // Sweeps the FULL on-chain balance of that asset at that address into the
      // central wallet — the same path a normal sweep takes, just for an asset
      // the payment never expected.
      const result = await adapter.sweepDeposit({
        paymentId: row.payment_id ?? row.id,
        depositAddress: row.deposit_address,
        derivationIndex: Number(row.derivation_index),
        asset: row.asset,
      });
      if (!result) {
        await markFailed(
          row.id,
          'Balance is below the minimum worth sweeping (the fee would exceed it)',
        );
        throw AppError.badRequest(
          'The amount is too small to recover — the network fee would cost more ' +
            'than the funds are worth.',
        );
      }
      await markSwept(row.id, result.txHash);
      await writeAudit({
        actorUserId: req.user?.userId ?? null,
        actorType: 'user',
        action: 'unexpected_deposit.recover',
        entityType: 'unexpected_deposit',
        entityId: row.id,
        metadata: { asset: row.asset, amount: row.amount, txHash: result.txHash },
        ip: req.ip,
      });
      res.status(200).json({ success: true, txHash: result.txHash });
    } catch (err) {
      // Leave a readable reason on the row so the merchant sees why, and allow a
      // retry (markFailed puts it back in a claimable state).
      const message = err instanceof Error ? err.message : 'Recovery failed';
      await markFailed(row.id, message);
      throw err;
    }
  }),
);

// ---------- GET /account/analytics ----------
//
// Aggregates for the merchant's own dashboard. It exists because the panel was
// computing every headline figure client-side from the most recent 500 payments
// — accurate for a small account, silently understated for a busy one, and it
// grew the payload with the merchant's success.
//
// THE MULTI-ASSET RULE APPLIES HERE, and it is the whole reason this response
// has the shape it does. Balances are not fungible across (network, asset): a
// merchant holding 100 USDT on BEP20 and 0.002 BTC does not have "100.002" of
// anything. So:
//
//   * `byAsset` is the AUTHORITATIVE breakdown — one row per pair, never summed.
//   * `totals.settledVolumeApprox` is a convenience sum across assets and is
//     named `Approx` so no caller mistakes it for a balance. It is only
//     defensible because every settleable asset is USD-denominated or has a
//     published USD price; it is NOT withdrawable and must never be shown as
//     available funds. GET /balance?all=true is the withdrawable figure.
//
// Amounts are returned as STRINGS. They are numeric(38,18) in Postgres, and
// JSON numbers are IEEE-754 doubles — round-tripping an 18-dp value through one
// loses precision. Counts are numbers because they are small integers.

const AnalyticsQuery = z.object({
  // Bounded: an unbounded window invites a full table scan per dashboard load.
  days: z.coerce.number().int().min(1).max(365).default(30),
});

router.get(
  '/account/analytics',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const { days } = AnalyticsQuery.parse(req.query);

    // Every query below is scoped by client_id. There is no path here that can
    // read another merchant's figures.
    const params = [client.clientId, days];

    const totals = await queryOne<{
      settled_volume: string;
      settled_count: string;
      in_flight_count: string;
      in_flight_amount: string;
      failed_count: string;
      expired_count: string;
      partial_count: string;
      finished_count: string;
      prev_settled_volume: string;
    }>(
      // make_interval() rather than ("$2 || ' days'")::interval on purpose. A
      // bind parameter gets ONE inferred type per statement, and the string
      // concatenation pins $2 to text — which then makes the `2 * $2` below fail
      // with "operator does not exist: integer * text". An explicit ::int cast
      // inside make_interval keeps it numeric everywhere it appears.
      `WITH win AS (
         SELECT now() - make_interval(days => $2::int)     AS start_at,
                now() - make_interval(days => 2 * $2::int) AS prev_start_at
       )
       SELECT
         COALESCE(SUM(p.amount_received) FILTER (
           WHERE p.status IN ('confirmed','swept') AND p.created_at >= win.start_at
         ), 0)::text AS settled_volume,
         COUNT(*) FILTER (
           WHERE p.status IN ('confirmed','swept') AND p.created_at >= win.start_at
         )::text AS settled_count,
         COUNT(*) FILTER (
           WHERE p.status IN ('waiting','confirming') AND p.created_at >= win.start_at
         )::text AS in_flight_count,
         COALESCE(SUM(p.amount) FILTER (
           WHERE p.status IN ('waiting','confirming') AND p.created_at >= win.start_at
         ), 0)::text AS in_flight_amount,
         COUNT(*) FILTER (
           WHERE p.status = 'failed' AND p.created_at >= win.start_at
         )::text AS failed_count,
         COUNT(*) FILTER (
           WHERE p.status = 'expired' AND p.created_at >= win.start_at
         )::text AS expired_count,
         COUNT(*) FILTER (
           WHERE p.status = 'partial' AND p.created_at >= win.start_at
         )::text AS partial_count,
         COUNT(*) FILTER (
           WHERE p.status IN ('confirmed','swept','failed','expired')
             AND p.created_at >= win.start_at
         )::text AS finished_count,
         -- The immediately preceding window of the same length, so the delta
         -- compares like with like rather than against a full calendar month.
         COALESCE(SUM(p.amount_received) FILTER (
           WHERE p.status IN ('confirmed','swept')
             AND p.created_at >= win.prev_start_at
             AND p.created_at <  win.start_at
         ), 0)::text AS prev_settled_volume
         FROM payments p, win
        WHERE p.client_id = $1
          AND p.created_at >= win.prev_start_at`,
      params,
    );

    const byStatus = await query<{ status: string; count: string }>(
      `SELECT status::text AS status, COUNT(*)::text AS count
         FROM payments
        WHERE client_id = $1
          AND created_at >= now() - make_interval(days => $2::int)
        GROUP BY status
        ORDER BY COUNT(*) DESC`,
      params,
    );

    // The authoritative breakdown. One row per (network, asset) — the only
    // figures on this endpoint that are safe to reason about as money.
    const byAsset = await query<{
      network: string;
      asset: string;
      count: string;
      volume: string;
    }>(
      `SELECT network,
              asset,
              COUNT(*)::text AS count,
              COALESCE(SUM(amount_received), 0)::text AS volume
         FROM payments
        WHERE client_id = $1
          AND status IN ('confirmed','swept')
          AND created_at >= now() - make_interval(days => $2::int)
        GROUP BY network, asset
        ORDER BY SUM(amount_received) DESC NULLS LAST`,
      params,
    );

    // generate_series so a day with no payments comes back as 0 rather than
    // being absent — a chart that skips empty days misreports the shape of the
    // trend.
    const timeseries = await query<{
      date: string;
      volume: string;
      count: string;
    }>(
      `WITH days AS (
         SELECT generate_series(
                  date_trunc('day', now()) - make_interval(days => $2::int - 1),
                  date_trunc('day', now()),
                  interval '1 day'
                ) AS d
       ),
       pay AS (
         SELECT date_trunc('day', created_at) AS d,
                COALESCE(SUM(amount_received), 0) AS volume,
                COUNT(*) AS cnt
           FROM payments
          WHERE client_id = $1
            AND status IN ('confirmed','swept')
            AND created_at >= date_trunc('day', now()) - make_interval(days => $2::int - 1)
          GROUP BY 1
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
              COALESCE(pay.volume, 0)::text AS volume,
              COALESCE(pay.cnt, 0)::text    AS count
         FROM days
         LEFT JOIN pay ON pay.d = days.d
        ORDER BY days.d ASC`,
      params,
    );

    const settledVolume = Number(totals?.settled_volume ?? 0);
    const prevVolume = Number(totals?.prev_settled_volume ?? 0);
    const finished = Number(totals?.finished_count ?? 0);
    const settledCount = Number(totals?.settled_count ?? 0);

    res.status(200).json({
      range: {
        days,
        from: new Date(Date.now() - days * 86_400_000).toISOString(),
        to: new Date().toISOString(),
      },
      totals: {
        // See the header: a cross-asset convenience sum, NOT a balance.
        settledVolumeApprox: totals?.settled_volume ?? '0',
        settledCount,
        inFlightCount: Number(totals?.in_flight_count ?? 0),
        inFlightAmountApprox: totals?.in_flight_amount ?? '0',
        failedCount: Number(totals?.failed_count ?? 0),
        expiredCount: Number(totals?.expired_count ?? 0),
        partialCount: Number(totals?.partial_count ?? 0),
        // Of the payments that REACHED a terminal state, how many were paid.
        // In-flight payments are excluded from both sides, otherwise a busy
        // minute would look like a collapse in success rate.
        successRate: finished === 0 ? 0 : (settledCount / finished) * 100,
        previousSettledVolumeApprox: totals?.prev_settled_volume ?? '0',
        // null rather than 0 when there is no prior volume: "no baseline" and
        // "no change" are different facts, and a caller rendering "+0%" for the
        // first month of trading would be lying to the merchant.
        volumeChangePct:
          prevVolume > 0 ? ((settledVolume - prevVolume) / prevVolume) * 100 : null,
      },
      byStatus: byStatus.map((r) => ({
        status: r.status,
        count: Number(r.count),
      })),
      byAsset: byAsset.map((r) => ({
        network: r.network,
        asset: r.asset,
        count: Number(r.count),
        volume: r.volume,
      })),
      timeseries: timeseries.map((r) => ({
        date: r.date,
        volume: r.volume,
        count: Number(r.count),
      })),
    });
  }),
);

// ---------- GET /account/webhook-logs ----------

router.get(
  '/account/webhook-logs',
  clientAuth,
  asyncHandler(async (req, res) => {
    const client = req.client!;
    const rows = await query<{
      id: string;
      event: string;
      payment_id: string | null;
      url: string;
      success: boolean;
      status_code: number | null;
      attempt: number;
      payload: unknown;
      response_body: string | null;
      created_at: string;
      next_retry_at: string | null;
    }>(
      `SELECT id, event, payment_id, url, success, status_code, attempt,
              payload, response_body, created_at, next_retry_at
         FROM webhook_logs
        WHERE client_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [client.clientId],
    );

    const logs = rows.map((r) => ({
      id: r.id,
      event: r.event,
      paymentId: r.payment_id ?? undefined,
      url: r.url,
      status: r.success ? 'success' : r.next_retry_at ? 'pending' : 'failed',
      httpStatus: r.status_code,
      attempt: r.attempt,
      maxAttempts: config.webhook.maxRetries,
      requestBody: JSON.stringify(r.payload),
      responseBody: r.response_body,
      createdAt: new Date(r.created_at).toISOString(),
      nextRetryAt: r.next_retry_at
        ? new Date(r.next_retry_at).toISOString()
        : null,
    }));
    res.status(200).json(logs);
  }),
);

export default router;
