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
 * stored `auth_mode` AND against which column the credential matched (see
 * `assertModeMatches`). A signed request against a simple key (or vice versa) is
 * rejected rather than falling back — otherwise an attacker holding a leaked
 * bearer token could simply omit the signature headers to dodge a stricter path,
 * and mode confusion is exactly how downgrade bugs happen. The column check is
 * the load-bearing half: `api_keys.api_key` holds a MASKED DISPLAY PREFIX for a
 * simple key, so authenticating a bearer request off that column would promote
 * a string printed in the dashboard into a working credential.
 */
import { NextFunction, Request, Response } from 'express';
import { BlockList, isIPv4, isIPv6 } from 'net';
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
  /**
   * WHICH COLUMN the presented credential matched. Both are projected because
   * the lookup below tests both in ONE statement, and the two columns mean
   * completely different things:
   *   api_key    — a PUBLIC id (hmac) or a MASKED DISPLAY PREFIX (simple).
   *                Neither is a secret; both are shown in the dashboard.
   *   token_hash — sha256 of the bearer token, which IS the secret.
   * So a row that matched on `api_key` must never authenticate a bearer
   * request: that would turn the masked prefix printed on the dashboard into a
   * working credential. The mode dispatch below therefore checks the flag, not
   * just the row.
   */
  matched_public: boolean | null;
  matched_token: boolean | null;
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

/**
 * ONE statement for both credential shapes.
 *
 * $1 is the presented credential verbatim, $2 its sha256. Previously a miss on
 * the mode-appropriate column ran a SECOND query against the other column
 * purely to produce a friendlier 401, so an unauthenticated caller controlled
 * two indexed lookups and two checkouts from a 20-slot pool per request —
 * exactly on the path where the pool is already the binding constraint.
 *
 * WHY UNION ALL AND NOT `WHERE a = $1 OR b = $2`. The OR form is not indexable
 * as one condition: the planner falls back to scanning `idx_api_keys_key` (every
 * ACTIVE key) and filtering, which turns the hottest query in the system into
 * O(keys). Two LIMIT-1 branches each keep their own index condition, and the
 * outer LIMIT 1 makes the second branch lazy — so a hit on the first costs one
 * index probe and only a MISS pays for both, in a single round trip. The
 * mode-appropriate branch is emitted first for that reason.
 *
 * Two rows cannot both match: `api_key` values are `pk_live_`+24 hex or
 * `ak_live_`+12 hex, `token_hash` values are 64-hex sha256 digests of a
 * 72-character token, so one presented string cannot be both. If that ever
 * stopped holding, the first branch wins and `assertModeMatches` fails closed.
 */
function keySelect(signed: boolean): string {
  const byPublicId = keyBranch('k.api_key = $1', 'true', 'false');
  const byToken = keyBranch('k.token_hash = $2', 'false', 'true');
  const [first, second] = signed ? [byPublicId, byToken] : [byToken, byPublicId];
  return `${first}\nUNION ALL\n${second}\nLIMIT 1`;
}

function keyBranch(predicate: string, matchedPublic: string, matchedToken: string): string {
  return `
  (SELECT k.id           AS api_key_id,
          k.api_secret_hash,
          k.auth_mode,
          ${signatureVersionColumn ? 'k.signature_version' : '1'} AS signature_version,
          k.scopes,
          c.id           AS client_id,
          c.business_name,
          c.status       AS client_status,
          c.ip_whitelist,
          ${matchedPublic} AS matched_public,
          ${matchedToken}  AS matched_token
     FROM api_keys k
     JOIN clients  c ON c.id = k.client_id
    WHERE k.status = 'active'
      AND ${predicate}
    LIMIT 1)`;
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
    const row = await lookupCredential(presented, signed);

    if (!row) {
      throw AppError.unauthorized('Unknown or revoked API key');
    }

    // MODE ASSERTION — the check the header block above has always claimed and
    // no code performed. It is what keeps the two credential shapes from being
    // interchangeable:
    //   - a bearer request must have matched `token_hash` (the secret), never
    //     `api_key` (the masked prefix, which is not a secret at all);
    //   - a signed request must have matched `api_key` on an hmac key, so a
    //     simple key's prefix cannot be dragged into the HMAC path (where it
    //     used to reach verifyHmac and 500 on a NULL secret).
    assertModeMatches(signed, row);

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
    //
    // THROTTLED TO ONE WRITE PER KEY PER MINUTE. Unconditionally, this wrote a
    // row on EVERY authenticated request: a second pool checkout per request
    // against a 20-slot pool, and one dead tuple per request on a tiny,
    // extremely hot table — which turns autovacuum on api_keys into a
    // foreground concern at the target load. The column feeds a dashboard
    // timestamp (listApiKeys -> routes/account.ts), never a security decision,
    // so minute granularity is the whole cost. The predicate does the filtering
    // in the database rather than here on purpose: it stays correct across
    // multiple api instances, which a per-process cache would not.
    query(
      `UPDATE api_keys
          SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.api_key_id],
    ).catch((err) => logger.warn({ err }, 'failed to update api_keys.last_used_at'));

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

/**
 * Look the presented credential up in both columns at once. The digest is what
 * matches a simple-mode token, so an attacker cannot probe for a valid prefix —
 * either the whole token hashes to a stored row or it does not.
 */
async function lookupCredential(
  presented: string,
  signed: boolean,
): Promise<ApiKeyRow | undefined> {
  const params = [presented, sha256Hex(presented)];
  try {
    const rows = await query<ApiKeyRow>(keySelect(signed), params);
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
      const rows = await query<ApiKeyRow>(keySelect(signed), params);
      return rows[0];
    }
    throw err;
  }
}

/**
 * Reject a credential presented in the wrong shape, with a message that names
 * the actual mistake — an integration that forgets to sign would otherwise be
 * told "unknown key", which sends people hunting the wrong bug. Nothing leaks:
 * every branch here has already matched a row on a value the merchant can read
 * off their own dashboard, and none of them reaches verification.
 */
function assertModeMatches(signed: boolean, row: ApiKeyRow): void {
  if (signed) {
    if (row.matched_public && row.auth_mode === 'hmac') return;
    throw AppError.unauthorized(
      row.auth_mode === 'simple'
        ? 'This is a bearer key — send it in X-Api-Key alone, with no X-Signature.'
        : 'Unknown or revoked API key',
    );
  }

  if (row.matched_token && row.auth_mode === 'simple') return;
  if (row.auth_mode === 'hmac') {
    throw AppError.unauthorized(
      'This key requires signed requests — send X-Timestamp and X-Signature.',
    );
  }
  // Matched a simple key on `api_key`, i.e. the masked display prefix rather
  // than the token. That prefix is not a credential and must never authenticate.
  throw AppError.unauthorized(
    'That is the masked display prefix shown in the dashboard, not the API key. ' +
      'Send the full ak_live_… token you were given when the key was created.',
  );
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

  // FAIL CLOSED WHEN THE BODY WAS NOT CAPTURED.
  //
  // req.rawBody is populated only by the `verify` hook on express.json(), whose
  // `type` defaults to application/json. Any other Content-Type makes
  // body-parser skip that hook, and the line below then silently degrades to
  // signing the EMPTY string — a signature verifier reporting success over
  // bytes it never saw. Nobody can exploit that today beyond the replay window,
  // but "the signature covered nothing" must never be a passing outcome, and v2
  // hashes rawBody directly.
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  const carriesBody =
    (Number.isFinite(declaredLength) && declaredLength > 0) ||
    Boolean(req.headers['transfer-encoding']);
  if (carriesBody && !req.rawBody) {
    throw AppError.unauthorized(
      'Request body was not covered by the signature. The merchant API accepts ' +
        'JSON only — send Content-Type: application/json so the body is signed ' +
        'and verified.',
    );
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
 *
 * CIDR. Entries containing a `/` are matched as ranges. This used to be exact
 * string equality only, so a merchant who entered `10.0.0.0/8` — the obvious
 * thing to enter, and what the settings UI invites — stored a value that could
 * never equal an IP address and locked every API key out of their own account
 * with a 403 whose only diagnostic was a server-side log. Adding range matching
 * is strictly widening: a literal IP still matches exactly as before, and an
 * entry with a `/` matched nothing at all before this.
 */
function enforceIpAllowlist(req: Request, row: ApiKeyRow): void {
  const allow = row.ip_whitelist ?? [];
  if (allow.length === 0) return;

  const ip = req.ip ?? '';
  const bare = ip.replace(/^::ffff:/, '');
  const candidates = new Set([ip, bare]);
  if (allow.some((entry) => candidates.has(entry.trim()))) return;
  if (matchesCidrEntry(allow, bare)) return;

  logger.warn(
    { clientId: row.client_id, apiKeyId: row.api_key_id, ip },
    'API request rejected: source IP not in client allowlist',
  );
  throw AppError.forbidden('Source IP is not allowed for this account');
}

/**
 * Parsed allowlists, keyed on the CIDR entries themselves. Building a BlockList
 * per request would be wasted work on the hottest path in the system; the key
 * is the entry list rather than the client id so a settings change is picked up
 * without any invalidation plumbing. Bounded, and a miss only costs a re-parse.
 */
const cidrCache = new Map<string, BlockList | null>();
const CIDR_CACHE_MAX = 500;

function matchesCidrEntry(allow: string[], ip: string): boolean {
  if (!ip) return false;
  const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
  if (!family) return false;

  const list = cidrListFor(allow);
  if (!list) return false;
  try {
    return list.check(ip, family);
  } catch {
    return false;
  }
}

function cidrListFor(allow: string[]): BlockList | null {
  const entries = allow.map((e) => e.trim()).filter((e) => e.includes('/'));
  if (entries.length === 0) return null;

  const cacheKey = entries.join(',');
  const cached = cidrCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const list = new BlockList();
  let added = 0;
  for (const entry of entries) {
    const cut = entry.lastIndexOf('/');
    const addr = entry.slice(0, cut);
    // The prefix must be an EXPLICIT run of digits. `Number('')` is 0, so
    // parsing with Number alone turned a truncated entry like `10.0.0.0/` — a
    // plausible typo, and `ipWhitelist` is stored unvalidated (routes/account.ts
    // accepts any 3..45-character string) — into `10.0.0.0/0`, i.e. a subnet
    // that matches EVERY address. That silently converts the allowlist into
    // "allow everything", which is the opposite of both the old behaviour (an
    // entry with a `/` matched nothing and the request was refused) and of the
    // rule stated below. `Number` also accepts '1e1' and ' 8'; the digits-only
    // test rejects those too.
    const prefixText = entry.slice(cut + 1);
    const prefix = /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : NaN;
    const family = isIPv4(addr) ? 'ipv4' : isIPv6(addr) ? 'ipv6' : null;
    const maxPrefix = family === 'ipv4' ? 32 : 128;
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      // Unparseable entries are ignored, exactly as they were before ranges
      // existed — never treated as "allow everything".
      logger.warn({ entry }, 'ignoring unparseable ip_whitelist CIDR entry');
      continue;
    }
    if (prefix === 0) {
      // Explicitly written /0. Honoured, because it is unambiguous, but it
      // matches the entire address space and therefore disables the control the
      // merchant thinks they configured — say so loudly rather than silently.
      logger.warn(
        { entry },
        'ip_whitelist entry has a /0 prefix and matches every address — the IP ' +
          'allowlist is effectively disabled for this account',
      );
    }
    try {
      list.addSubnet(addr, prefix, family);
      added += 1;
    } catch (err) {
      logger.warn({ err, entry }, 'ignoring unparseable ip_whitelist CIDR entry');
    }
  }

  const result = added > 0 ? list : null;
  if (cidrCache.size >= CIDR_CACHE_MAX) cidrCache.clear();
  cidrCache.set(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/**
 * Route guard: require a scope on whatever credential authenticated. Use AFTER
 * `clientAuth`/`merchantAuth`.
 *
 * A dashboard session is granted every scope by clientAuth — the human is the
 * account owner and is already past login. Scopes exist to constrain long-lived
 * machine credentials, not people.
 *
 * This note used to add "and MFA". It should not: `users.mfa_enabled` /
 * `mfa_secret` are READ at routes/auth.ts and redacted in the logger, and that
 * is the complete set of references — nothing in the product ever WRITES them,
 * so there is no enrolment path and no second factor behind any session. Do not
 * size a threat model around it until that is built.
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
