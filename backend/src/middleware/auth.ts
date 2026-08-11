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
 *   Key:            the raw API secret
 *   Verify:         constant-time compare of hex signatures.
 *
 *   SIGNED STRING — v2 (current):
 *       `${X-Timestamp}.${METHOD}.${originalUrl}.${sha256Hex(rawBody)}`
 *     METHOD      uppercase HTTP verb, e.g. POST
 *     originalUrl the path AS SENT ON THE WIRE, including the /api/v1 mount
 *                 prefix and the query string verbatim, e.g.
 *                 `/api/v1/payments?limit=10`. Not URL-decoded, not reordered.
 *     rawBody     the exact bytes of the body; the EMPTY STRING for a
 *                 body-less request, so its sha256 is the well-known
 *                 e3b0c442…b855 digest rather than nothing at all.
 *
 *   SIGNED STRING — v1 (LEGACY, being retired):
 *       `${X-Timestamp}.${rawBody}`
 *
 *   WHY v2 EXISTS. v1 bound neither the method nor the path, and every
 *   body-less request at a given second signs BYTE-IDENTICAL bytes. So a
 *   signature lifted from a routine `GET /payments` poll — a request a merchant
 *   makes constantly, over TLS but through their own proxies and logs — is a
 *   valid signature for `POST /invoices/{id}/void`, `POST /payouts`, and every
 *   other body-less mutation, for the whole 5-minute skew window. The timestamp
 *   check bounds the window; it does not bound the ENDPOINT, and that was the
 *   hole.
 *
 *   MIGRATION. `api_keys.signature_version` (migration 023) says what a given
 *   key is held to:
 *     1 (default, and what every pre-existing key is) — accept v2 OR v1. This
 *       is the deprecation window: an SDK can upgrade at any time without an
 *       operator flipping anything, and an un-upgraded SDK keeps working.
 *     2 — accept v2 ONLY. Flip a key to 2 once its integration is upgraded;
 *       that flip is what actually closes the hole for that merchant.
 *   docs/sdk/{javascript,php,python}.md and docs/openapi.yaml are the normative
 *   definition of this scheme for merchants and MUST be updated in the same
 *   change — see the note at the bottom of this block.
 *
 *   REPLAY GUARD, two layers:
 *     1. Skew: reject if |now - timestamp| > 5 minutes (as before).
 *     2. Nonce: a verified signature for a MUTATING method (anything that is
 *        not GET/HEAD/OPTIONS) is burned in Redis for 11 minutes — both sides
 *        of the window — so the same signature cannot be presented twice even
 *        inside it. Reads are NOT burned, under either version: under v2 a
 *        replayed read can only repeat the identical read, and under v1 every
 *        body-less request in a given second signs identical bytes, so burning
 *        reads there would reject ordinary concurrent polling. See the long
 *        comment at the burn site — that asymmetry is deliberate and is the
 *        difference between a hardening and an outage. Fails OPEN on a Redis
 *        error — a cache outage must not take the whole merchant API down; see
 *        rateLimit.ts for the same trade-off argued at length.
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
import { redis } from '../db/redis';

const MAX_SKEW_SECONDS = 5 * 60; // 5 minutes replay window
// A burned signature must stay burned for the whole window it could be replayed
// in — 300s of past skew plus 300s of future skew, plus a minute of slack.
const NONCE_TTL_SECONDS = MAX_SKEW_SECONDS * 2 + 60;

interface ApiKeyRow {
  api_key_id: string;
  api_secret_hash: string | null; // envelope-encrypted raw secret (hmac only)
  auth_mode: 'hmac' | 'simple';
  signature_version: number | null; // 1 = accept v2 or legacy v1, 2 = v2 only
  scopes: string[] | null;
  client_id: string;
  business_name: string;
  client_status: string;
  ip_whitelist: string[] | null;
}

/**
 * `api_keys.signature_version` arrives in migration 023. If the code is
 * deployed ahead of the migration the column is simply absent, and a hard
 * failure there would 500 EVERY merchant request — a total API outage caused by
 * a hardening change. So the first `undefined_column` demotes the projection to
 * a literal 1 for the life of the process, which is exactly the pre-migration
 * behaviour (accept v2 or v1) and is logged at ERROR so it cannot pass
 * unnoticed. Restart after applying the migration to pick the column back up.
 */
let signatureVersionColumn = true;

function keySelect(): string {
  return `
  SELECT k.id           AS api_key_id,
         k.api_secret_hash,
         k.auth_mode,
         ${signatureVersionColumn ? 'k.signature_version' : '1'} AS signature_version,
         k.scopes,
         c.id           AS client_id,
         c.business_name,
         c.status       AS client_status,
         c.ip_whitelist
    FROM api_keys k
    JOIN clients  c ON c.id = k.client_id
   WHERE k.status = 'active'
`;
}

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
      await verifyHmac(req, row, timestamp, signature);
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
  return selectKey('AND k.api_key = $1', apiKey);
}

/**
 * Simple mode. The digest is the lookup key, so an attacker cannot probe for a
 * valid prefix — either the whole token hashes to a stored row or it does not.
 */
async function lookupByToken(token: string): Promise<ApiKeyRow | undefined> {
  return selectKey('AND k.token_hash = $1', sha256Hex(token));
}

async function selectKey(
  predicate: string,
  param: string,
): Promise<ApiKeyRow | undefined> {
  try {
    const rows = await query<ApiKeyRow>(`${keySelect()} ${predicate} LIMIT 1`, [param]);
    return rows[0];
  } catch (err) {
    // 42703 = undefined_column: migration 023 has not been applied yet.
    if (signatureVersionColumn && (err as { code?: string })?.code === '42703') {
      signatureVersionColumn = false;
      logger.error(
        { err },
        'api_keys.signature_version is missing (migration 023 not applied); ' +
          'treating every key as signature_version=1 — legacy v1 signatures ' +
          'stay accepted until the migration runs and the API restarts',
      );
      const rows = await query<ApiKeyRow>(`${keySelect()} ${predicate} LIMIT 1`, [param]);
      return rows[0];
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifyHmac(
  req: Request,
  row: ApiKeyRow,
  timestamp: string | undefined,
  signature: string | undefined,
): Promise<void> {
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
  const presented = signature.toLowerCase();

  // v2 binds the verb and the exact path+query, so a signature captured from a
  // GET poll is not a signature for POST /payouts. `originalUrl` is the path as
  // the client sent it, before any router mounting rewrote req.url — the same
  // bytes the merchant SDK has in hand when it signs.
  const method = req.method.toUpperCase();
  const path = req.originalUrl;
  const v2 = hmacSha256(
    secret,
    `${timestamp}.${method}.${path}.${sha256Hex(rawBody)}`,
  );

  let matched: 'v2' | 'v1' | null = safeEqual(v2, presented) ? 'v2' : null;

  // Deprecation window: a key still at version 1 also accepts the old
  // timestamp+body form, so upgrading the SDK and flipping the key are two
  // independent steps and neither one alone breaks the integration.
  const version = Number(row.signature_version ?? 1);
  if (!matched && version < 2) {
    if (safeEqual(hmacSha256(secret, `${timestamp}.${rawBody}`), presented)) {
      matched = 'v1';
      warnLegacySignature(row);
    }
  }

  if (!matched) {
    throw AppError.unauthorized(
      version >= 2
        ? 'Bad signature (this key requires the v2 signed string: ' +
            'timestamp.METHOD.path.sha256(body))'
        : 'Bad signature',
    );
  }

  // WHICH REQUESTS GET BURNED — mutating methods only, under BOTH versions.
  //
  //   v2 — a v2 signature is welded to this method, this path and these body
  //        bytes, so two DIFFERENT requests can never collide. Burning is
  //        therefore true single-use: replaying it can at worst repeat the
  //        exact same call, which for a read is harmless (and refusing it would
  //        401 two workers polling the same resource in the same second) and
  //        for a write is the attack.
  //
  //   v1 — burned for writes only, and this is a deliberate, load-bearing
  //        limitation. DO NOT "harden" this by burning v1 reads as well.
  //        Under v1 the signed string is `${timestamp}.${rawBody}` and NOTHING
  //        else, so every body-less request a key makes in a given SECOND signs
  //        byte-identical bytes and produces the IDENTICAL signature. A nonce
  //        cannot tell a replay apart from ordinary concurrency there — that
  //        indistinguishability IS the v1 defect. Burning every v1 request
  //        would 401 the second and every subsequent status poll a merchant
  //        makes in the same second, which is the single most common request
  //        this API serves; at the target load, and with every key defaulting
  //        to signature_version = 1 until its SDK is upgraded, that is a total
  //        merchant-API outage, not a hardening.
  //        Writes are burned because there the trade flips: body-less or
  //        identical-body mutations in the same second are rare and the 401
  //        self-heals on a re-signed retry (the SDK stamps a fresh X-Timestamp
  //        per call), while a replayed void/cancel/payout is the damage. It
  //        bounds a captured v1 signature to ONE use against a write instead of
  //        unlimited use; the full close is flipping the key to
  //        signature_version = 2, which is what that column exists for.
  //
  // Consequence to keep in mind: a client that retries a WRITE by resending the
  // byte-identical request (same X-Timestamp, same X-Signature) now gets a 401
  // telling it to re-sign, instead of a second execution. Idempotency-Key still
  // does its job on the re-signed retry.
  const safeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (!safeMethod) {
    await burnSignature(row.api_key_id, presented);
  }
}

/**
 * Single-use enforcement. The skew check bounds how LONG a captured signature
 * lives; this bounds how MANY times it can be used inside that window, which is
 * the difference between "an attacker can replay your void/payout once" and
 * "not at all".
 *
 * Keyed by (api_key_id, signature) rather than signature alone so one merchant
 * can never invalidate another's request, and only ever reached AFTER the HMAC
 * verified — an unauthenticated flood cannot write a single key into Redis.
 *
 * FAILS OPEN on a Redis error, deliberately: this middleware sits in front of
 * every merchant request, and turning a cache blip into a total gateway outage
 * is the worse failure for a system that is mid-payment for real customers.
 * The skew window and the per-key rate limiter still apply in that state, and
 * the degradation is logged at ERROR.
 */
async function burnSignature(apiKeyId: string, signature: string): Promise<void> {
  try {
    const first = await redis.set(
      `hmac:nonce:${apiKeyId}:${signature}`,
      '1',
      'EX',
      NONCE_TTL_SECONDS,
      'NX',
    );
    if (first === null) {
      throw AppError.unauthorized(
        'Signature already used — sign each request with a fresh X-Timestamp ' +
          '(replay protection). Retries must be re-signed.',
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(
      { err, apiKeyId },
      'HMAC replay cache unavailable; accepting the request on skew check alone',
    );
  }
}

/**
 * One line per key per 10 minutes, not one per request: at 1,000 concurrent
 * requests an unthrottled deprecation warning is itself an outage.
 */
const legacyWarnedAt = new Map<string, number>();
const LEGACY_WARN_INTERVAL_MS = 10 * 60 * 1000;

function warnLegacySignature(row: ApiKeyRow): void {
  const now = Date.now();
  const last = legacyWarnedAt.get(row.api_key_id) ?? 0;
  if (now - last < LEGACY_WARN_INTERVAL_MS) return;
  if (legacyWarnedAt.size > 1000) legacyWarnedAt.clear(); // bound the map
  legacyWarnedAt.set(row.api_key_id, now);
  logger.warn(
    { apiKeyId: row.api_key_id, clientId: row.client_id },
    'merchant is still signing with the legacy v1 scheme (timestamp.body), ' +
      'which binds neither method nor path — upgrade the SDK, then set ' +
      'api_keys.signature_version = 2 for this key',
  );
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
