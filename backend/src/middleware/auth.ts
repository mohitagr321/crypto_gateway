/**
 * Merchant API authentication. Two credential shapes, one code path.
 *
 * ============================ HMAC / SECRET DESIGN =============================
 * The schema fixes `api_keys.api_secret_hash` as the per-key secret column and
 * its column comment says "bcrypt/argon2 of secret". However, HMAC request
 * signing requires the *raw* secret on the server to recompute the signature —
 * a bcrypt hash is one-way and cannot be used for HMAC.
 *
 * DECISION (documented here and mirrored in services/apiKeyService.ts):
 *   We repurpose `api_secret_hash` as an ENVELOPE-ENCRYPTED store of the raw API
 *   secret (AES-256-GCM via MASTER_ENCRYPTION_KEY), NOT a bcrypt hash. The column
 *   name is kept for schema compatibility. On each authenticated request we
 *   `decrypt()` the stored secret and recompute the HMAC. The plaintext secret is
 *   only ever returned to the merchant ONCE at creation time.
 *
 *   Note the contrast with `token_hash` below: a simple-mode token is only ever
 *   RECOGNISED, never recomputed from, so it is a plain SHA-256 digest. Reversible
 *   storage is a cost we pay only where HMAC forces it.
 *
 * ============================ SIGNATURE SCHEME (hmac) =========================
 *   Headers:  X-Api-Key   -> public key id (api_keys.api_key)
 *             X-Timestamp -> unix seconds (string)
 *             X-Signature -> hex HMAC-SHA256
 *   Signed string:  `${X-Timestamp}.${rawBody}`
 *   Key:            the raw API secret
 *   Verify:        constant-time compare of hex signatures.
 *   Replay guard:  reject if |now - timestamp| > 5 minutes.
 *
 * The OUTBOUND webhook uses the same hmacSha256 primitive over its JSON body with
 * the per-client webhook secret (see webhookService), keeping the two symmetric.
 *
 * ============================ BEARER SCHEME (simple) ==========================
 *   Header:   X-Api-Key -> the whole `ak_live_…` token, which IS the secret.
 *   Verify:   look the row up by sha256(token), then constant-time compare.
 *
 *   Chosen because it is what merchants expect from a crypto gateway, but it is
 *   strictly weaker: the credential is on the wire on every request and ends up
 *   in proxy logs and shell history. THREE controls contain that, and all three
 *   live below — do not remove one without removing the mode:
 *     1. Scopes. Simple keys are issued without `payouts:write`, so a leaked
 *        token cannot initiate a settlement.
 *     2. IP allowlist. `clients.ip_whitelist`, enforced here for BOTH modes.
 *     3. Settlement destination is not reachable with an API key at all —
 *        changing the payout wallet needs a dashboard session
 *        (`requireDashboardSession` in clientAuth.ts).
 *
 * ============================== MODE SELECTION ================================
 * Dispatch is on the PRESENCE of X-Signature, then checked against the key's
 * stored `auth_mode`. A signed request against a simple key (or vice versa) is
 * rejected rather than falling back — otherwise an attacker holding a leaked
 * bearer token could simply omit the signature headers to dodge a stricter path,
 * and mode confusion is exactly how downgrade bugs happen.
 */
import { NextFunction, Request, Response } from 'express';
import { query } from '../db/pool';
import { decrypt, hmacSha256, safeEqual, sha256Hex } from '../utils/crypto';
import { AppError } from '../utils/apiError';
import { logger } from '../config/logger';
import { Scope } from '../services/apiKeyService';
import { apiKeyRateLimiter } from './rateLimit';

const MAX_SKEW_SECONDS = 5 * 60; // 5 minutes replay window

interface ApiKeyRow {
  api_key_id: string;
  api_secret_hash: string | null; // envelope-encrypted raw secret (hmac only)
  auth_mode: 'hmac' | 'simple';
  scopes: string[] | null;
  client_id: string;
  business_name: string;
  client_status: string;
  ip_whitelist: string[] | null;
}

const KEY_SELECT = `
  SELECT k.id           AS api_key_id,
         k.api_secret_hash,
         k.auth_mode,
         k.scopes,
         c.id           AS client_id,
         c.business_name,
         c.status       AS client_status,
         c.ip_whitelist
    FROM api_keys k
    JOIN clients  c ON c.id = k.client_id
   WHERE k.status = 'active'
`;

export async function merchantAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const presented = header(req, 'x-api-key');
    const timestamp = header(req, 'x-timestamp');
    const signature = header(req, 'x-signature');

    if (!presented) {
      throw AppError.unauthorized('Missing X-Api-Key');
    }

    const signed = Boolean(timestamp || signature);
    const row = signed
      ? await lookupByPublicId(presented)
      : await lookupByToken(presented);

    if (!row) {
      // The two modes look the credential up in different columns, so a
      // mode/credential mismatch simply misses. Probe the other column purely to
      // return a diagnosable error — an integration that forgets to sign would
      // otherwise be told "unknown key", which sends people hunting the wrong
      // bug. The probe leaks nothing: it can only confirm that a PUBLIC key id
      // exists, and it never reaches verification.
      const other = signed
        ? await lookupByToken(presented)
        : await lookupByPublicId(presented);
      if (other) {
        throw AppError.unauthorized(
          other.auth_mode === 'hmac'
            ? 'This key requires signed requests — send X-Timestamp and X-Signature.'
            : 'This is a bearer key — send it in X-Api-Key alone, with no X-Signature.',
        );
      }
      throw AppError.unauthorized('Unknown or revoked API key');
    }

    if (signed) {
      verifyHmac(req, row, timestamp, signature);
    }

    if (row.client_status !== 'approved') {
      throw AppError.forbidden(`Client is ${row.client_status}, not approved`);
    }

    enforceIpAllowlist(req, row);

    req.client = {
      apiKeyId: row.api_key_id,
      clientId: row.client_id,
      businessName: row.business_name,
      status: row.client_status,
      authMode: row.auth_mode,
      scopes: row.scopes ?? [],
    };

    // Fire-and-forget; must not block or fail the request.
    query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [row.api_key_id]).catch(
      (err) => logger.warn({ err }, 'failed to update api_keys.last_used_at'),
    );

    // Per-key throttle — chained here rather than mounted on the router because
    // it keys on `req.client.apiKeyId`, which only exists once the lines above
    // have run. Mounted globally it would see no key and skip every request.
    // This is what bounds a leaked bearer token between the leak and the revoke.
    apiKeyRateLimiter(req, res, next);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

async function lookupByPublicId(apiKey: string): Promise<ApiKeyRow | undefined> {
  const rows = await query<ApiKeyRow>(`${KEY_SELECT} AND k.api_key = $1 LIMIT 1`, [
    apiKey,
  ]);
  return rows[0];
}

/**
 * Simple mode. The digest is the lookup key, so an attacker cannot probe for a
 * valid prefix — either the whole token hashes to a stored row or it does not.
 */
async function lookupByToken(token: string): Promise<ApiKeyRow | undefined> {
  const rows = await query<ApiKeyRow>(`${KEY_SELECT} AND k.token_hash = $1 LIMIT 1`, [
    sha256Hex(token),
  ]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function verifyHmac(
  req: Request,
  row: ApiKeyRow,
  timestamp: string | undefined,
  signature: string | undefined,
): void {
  if (!timestamp || !signature) {
    throw AppError.unauthorized('Missing X-Timestamp / X-Signature');
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw AppError.unauthorized('Invalid X-Timestamp');
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) {
    throw AppError.unauthorized('Timestamp outside allowed window (replay protection)');
  }

  if (!row.api_secret_hash) {
    // Schema CHECK makes this unreachable; treat it as corruption, not a 401.
    logger.error({ apiKeyId: row.api_key_id }, 'hmac key has no stored secret');
    throw AppError.internal('API key secret unreadable');
  }

  let secret: string;
  try {
    secret = decrypt(row.api_secret_hash);
  } catch {
    logger.error({ apiKeyId: row.api_key_id }, 'failed to decrypt stored api secret');
    throw AppError.internal('API key secret unreadable');
  }

  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  const expected = hmacSha256(secret, `${timestamp}.${rawBody}`);

  if (!safeEqual(expected, signature.toLowerCase())) {
    throw AppError.unauthorized('Bad signature');
  }
}

/**
 * `clients.ip_whitelist` — an empty array means unrestricted, which is the
 * default and what every pre-existing merchant has, so switching this on cannot
 * break an existing integration.
 *
 * `req.ip` is trustworthy here because index.ts sets `trust proxy` for the one
 * load balancer in front of the API. Both IPv4 and the IPv6-mapped form of the
 * same address are accepted, because a dual-stack proxy will present
 * `::ffff:1.2.3.4` for what the merchant entered as `1.2.3.4`.
 */
function enforceIpAllowlist(req: Request, row: ApiKeyRow): void {
  const allow = row.ip_whitelist ?? [];
  if (allow.length === 0) return;

  const ip = req.ip ?? '';
  const candidates = new Set([ip, ip.replace(/^::ffff:/, '')]);
  if (allow.some((entry) => candidates.has(entry.trim()))) return;

  logger.warn(
    { clientId: row.client_id, apiKeyId: row.api_key_id, ip },
    'API request rejected: source IP not in client allowlist',
  );
  throw AppError.forbidden('Source IP is not allowed for this account');
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Route guard: require a scope on whatever credential authenticated. Use AFTER
 * `clientAuth`/`merchantAuth`.
 *
 * A dashboard session is granted every scope by clientAuth — the human is the
 * account owner and is already past login and (where enabled) MFA. Scopes exist
 * to constrain long-lived machine credentials, not people.
 */
export function requireScope(scope: Scope) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const client = req.client;
    if (!client) {
      next(AppError.unauthorized());
      return;
    }
    if (!client.scopes.includes(scope)) {
      next(
        AppError.forbidden(
          `This API key lacks the '${scope}' scope.` +
            (scope === 'payouts:write'
              ? ' Payouts require an HMAC-signed key or a dashboard session.'
              : ''),
        ),
      );
      return;
    }
    next();
  };
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
