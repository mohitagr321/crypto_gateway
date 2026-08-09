/**
 * API key issuance, listing and revocation — the ONE place keys are minted.
 *
 * Both the admin path (POST /admin/clients, PUT /admin/clients/:id
 * regenerate-keys) and the merchant path (POST /account/api-keys) call in here,
 * so the two can never drift on scopes, prefixes or storage format.
 *
 * ============================== THE TWO MODES ================================
 * 'hmac'   — the historical scheme, and still the default. `api_key` is a PUBLIC
 *            id (pk_live_…); the secret (sk_live_…) is stored envelope-encrypted
 *            in `api_secret_hash` because the server must recompute the request
 *            HMAC from it. See the long design note in middleware/auth.ts.
 *
 * 'simple' — a single opaque bearer token (ak_live_…) sent in X-Api-Key with no
 *            signing, matching what most crypto gateways expose. The token IS
 *            the secret, so only its SHA-256 is stored, in `token_hash`; nothing
 *            ever needs to read it back. `api_key` holds a masked display prefix
 *            for the dashboard.
 *
 * ============================ WHY SIMPLE IS SCOPED ===========================
 * A signed request proves possession of a secret that never crosses the wire; a
 * bearer token is on the wire every time and lands in logs, proxies and browser
 * history. So a simple key is issued WITHOUT `payouts:write`: it can take money
 * in and read state, but cannot initiate a settlement. Moving funds requires
 * either a signed HMAC request or a logged-in dashboard session. Combined with
 * the IP allowlist (enforced in middleware/auth.ts) that keeps a leaked bearer
 * token from becoming a loss.
 */
import { PoolClient } from 'pg';
import { query, queryOne } from '../db/pool';
import { encrypt, randomToken, sha256Hex } from '../utils/crypto';
import { AppError } from '../utils/apiError';

export type AuthMode = 'hmac' | 'simple';

/** Every scope the system understands. Routes declare what they require. */
export const SCOPES = {
  paymentsRead: 'payments:read',
  paymentsWrite: 'payments:write',
  payoutsWrite: 'payouts:write',
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

export const ALL_SCOPES: Scope[] = [
  SCOPES.paymentsRead,
  SCOPES.paymentsWrite,
  SCOPES.payoutsWrite,
];

/**
 * What a key gets when the caller does not choose. HMAC keys keep the full set
 * so existing behaviour is unchanged; simple keys deliberately omit payouts.
 */
export function defaultScopes(mode: AuthMode): Scope[] {
  return mode === 'simple'
    ? [SCOPES.paymentsRead, SCOPES.paymentsWrite]
    : [...ALL_SCOPES];
}

/**
 * Scopes a merchant is allowed to request for a given mode. Asking for
 * `payouts:write` on a simple key is rejected rather than silently downgraded —
 * silently narrowing a permission the caller asked for produces confusing 403s
 * later, at a worse moment.
 */
export function assertScopesAllowed(mode: AuthMode, scopes: Scope[]): void {
  const unknown = scopes.filter((s) => !ALL_SCOPES.includes(s));
  if (unknown.length) {
    throw AppError.badRequest(`Unknown scope(s): ${unknown.join(', ')}`);
  }
  if (mode === 'simple' && scopes.includes(SCOPES.payoutsWrite)) {
    throw AppError.badRequest(
      'payouts:write cannot be granted to a simple (bearer) key. A leaked bearer ' +
        'token would be able to move funds. Use an HMAC-signed key for payouts.',
    );
  }
}

export function hasScope(scopes: string[] | null | undefined, required: Scope): boolean {
  return Array.isArray(scopes) && scopes.includes(required);
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

/**
 * The value shown in the dashboard after creation. For HMAC keys the public id
 * is not a secret and is shown whole; for simple keys only a prefix is kept, so
 * a merchant can still tell two keys apart without the token being recoverable.
 */
export function maskToken(token: string): string {
  return `${token.slice(0, 16)}${'•'.repeat(8)}`;
}

export interface NewKeyMaterial {
  /** Stored in api_keys.api_key — public id (hmac) or display prefix (simple). */
  displayKey: string;
  /** Returned to the merchant EXACTLY once. The sk_live secret, or the token. */
  oneTimeSecret: string;
  encryptedSecret: string | null;
  tokenHash: string | null;
}

export function generateKeyMaterial(mode: AuthMode): NewKeyMaterial {
  if (mode === 'simple') {
    // 32 random bytes of entropy in the token itself; the 12-hex display prefix
    // is drawn from the same value so a merchant can match the dashboard row to
    // the credential in their config.
    const body = randomToken(32);
    const token = `ak_live_${body}`;
    return {
      displayKey: `ak_live_${body.slice(0, 12)}`,
      oneTimeSecret: token,
      encryptedSecret: null,
      tokenHash: sha256Hex(token),
    };
  }
  const secret = `sk_live_${randomToken(24)}`;
  return {
    displayKey: `pk_live_${randomToken(12)}`,
    oneTimeSecret: secret,
    encryptedSecret: encrypt(secret),
    tokenHash: null,
  };
}

// ---------------------------------------------------------------------------
// Create / list / revoke
// ---------------------------------------------------------------------------

export interface CreateApiKeyInput {
  clientId: string;
  label: string;
  authMode?: AuthMode;
  scopes?: Scope[];
}

export interface CreatedApiKey {
  id: string;
  /** api_keys.api_key — public id or masked prefix. */
  apiKey: string;
  /** Shown ONCE. sk_live_… for hmac, the full ak_live_… token for simple. */
  secret: string;
  authMode: AuthMode;
  scopes: Scope[];
  createdAt: string;
}

/**
 * Insert a key. Runs inside the caller's transaction when one is supplied so
 * that "create client + create key" stays atomic (see routes/admin.ts).
 */
export async function createApiKey(
  input: CreateApiKeyInput,
  tx?: PoolClient,
): Promise<CreatedApiKey> {
  const mode: AuthMode = input.authMode ?? 'hmac';
  const scopes = input.scopes ?? defaultScopes(mode);
  assertScopesAllowed(mode, scopes);

  const material = generateKeyMaterial(mode);
  const sql = `INSERT INTO api_keys
                 (client_id, api_key, api_secret_hash, token_hash, auth_mode, scopes, label, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
               RETURNING id, created_at`;
  const args = [
    input.clientId,
    material.displayKey,
    material.encryptedSecret,
    material.tokenHash,
    mode,
    scopes,
    input.label,
  ];

  const row = tx
    ? (await tx.query<{ id: string; created_at: string }>(sql, args)).rows[0]
    : await queryOne<{ id: string; created_at: string }>(sql, args);

  if (!row) throw AppError.internal('failed to create API key');

  return {
    id: row.id,
    apiKey: material.displayKey,
    secret: material.oneTimeSecret,
    authMode: mode,
    scopes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface ApiKeySummary {
  id: string;
  apiKey: string;
  label: string | null;
  authMode: AuthMode;
  scopes: string[];
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  api_key: string;
  label: string | null;
  auth_mode: AuthMode;
  scopes: string[];
  status: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function toSummary(r: ApiKeyRow): ApiKeySummary {
  return {
    id: r.id,
    // A simple key's stored value is already a truncated prefix; append the dots
    // at render time so the DB holds no decorative characters.
    apiKey: r.auth_mode === 'simple' ? `${r.api_key}${'•'.repeat(8)}` : r.api_key,
    label: r.label,
    authMode: r.auth_mode,
    scopes: r.scopes ?? [],
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
  };
}

/** Active keys first, newest first. Revoked keys are kept for the audit trail. */
export async function listApiKeys(
  clientId: string,
  includeRevoked = false,
): Promise<ApiKeySummary[]> {
  const rows = await query<ApiKeyRow>(
    `SELECT id, api_key, label, auth_mode, scopes, status::text,
            created_at, last_used_at, revoked_at
       FROM api_keys
      WHERE client_id = $1
        ${includeRevoked ? '' : `AND status = 'active'`}
      ORDER BY (status = 'active') DESC, created_at DESC`,
    [clientId],
  );
  return rows.map(toSummary);
}

/**
 * Revoke one key. Scoped by client_id so a merchant can never revoke another
 * merchant's key by guessing an id.
 */
export async function revokeApiKey(clientId: string, keyId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE api_keys
        SET status = 'revoked', revoked_at = now()
      WHERE id = $1 AND client_id = $2 AND status = 'active'
      RETURNING id`,
    [keyId, clientId],
  );
  return Boolean(row);
}
