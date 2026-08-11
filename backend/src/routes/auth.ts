/**
 * Auth routes: dashboard login (merchant + admin) and token refresh.
 *
 * Any account with MFA enabled must present a valid, unused TOTP token.
 * Returns { accessToken, refreshToken, mfaRequired }.
 *
 * MFA IS NOT ACTUALLY REACHABLE. `users.mfa_enabled` / `users.mfa_secret` are
 * read here and redacted in the logger, and that is every reference in the
 * repo: no route, script or seed ever writes them, so no account can have a
 * second factor and the admin panel's MFA field is a control the server can
 * never demand. The code below is kept correct — fail closed when the columns
 * disagree, single-use codes — but do not count MFA as a control that exists.
 * Building it is three routes (enroll / confirm / disable) plus an admin
 * equivalent; see the audit entry.
 *
 * ========================== REFRESH TOKENS ARE REVOCABLE =====================
 * WHAT WAS WRONG. /refresh used to verify the JWT and then rebuild its claims
 * FROM THAT JWT — `{ sub: payload.sub, role: payload.role, email: payload.email }`
 * — minting a fresh access token and a fresh 7-day refresh token without ever
 * looking at the database. Three consequences, all real:
 *   - Suspending a user did nothing. Setting `users.status` away from 'active'
 *     is checked at /login and nowhere else, so a suspended admin refreshed
 *     their way to a working session indefinitely; each refresh extended the
 *     7-day window, so "indefinitely" is literal.
 *   - Demotion did nothing. `role` came out of the token, so a user demoted
 *     from super_admin kept super_admin in every token they minted afterwards.
 *   - A stolen refresh token was a permanent credential. There was no record of
 *     it server-side, so there was nothing to revoke and no way to notice it
 *     was being used twice. Changing the password did not help either.
 *
 * WHAT IT DOES NOW.
 *   1. Every refresh re-reads users + roles and builds the claims from those
 *      COLUMNS, and 401s unless `status = 'active'`. Revocation latency is now
 *      one access-token lifetime (JWT_EXPIRES_IN, 15m by default) instead of
 *      forever, for both suspension and demotion.
 *   2. Refresh tokens are tracked in `refresh_tokens` (migration 023) and
 *      ROTATE: presenting one consumes it atomically and issues a replacement
 *      in the same family. Presenting a consumed one again is reuse — the whole
 *      family is revoked, which logs out the thief AND the victim, and is
 *      audited. That is the standard detection: the legitimate holder noticing
 *      they were signed out is the alarm.
 *   3. `authRateLimiter` now guards /refresh as it already guarded /login.
 *
 * WHAT IT STILL DOES NOT DO. Access tokens are stateless and are NOT checked
 * against the database (middleware/jwtAuth.ts), so a suspension takes effect on
 * the next refresh, not the next request. Closing that last gap needs
 * `users.token_version` in the JWT payload and a DB check in jwtAuth — that
 * touches jwtAuth.ts, account.ts, register.ts and admin.ts, which belong to
 * other changes; migration 023 therefore deliberately stops at refresh_tokens.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { z } from 'zod';
import { asyncHandler, AppError } from '../utils/apiError';
import { query, queryOne } from '../db/pool';
import { decrypt, sha256Hex } from '../utils/crypto';
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
} from '../middleware/jwtAuth';
import { authRateLimiter } from '../middleware/rateLimit';
import { writeAudit } from '../services/auditService';
import { logger } from '../config/logger';
import { redis } from '../db/redis';

const router = Router();

/**
 * A refresh token that verifies but has no `refresh_tokens` row. That is the
 * normal state for every token minted BEFORE this deploy (they are valid for up
 * to JWT_REFRESH_EXPIRES_IN = 7 days) and for tokens minted by an api instance
 * still running the old code during a rolling deploy. Rejecting them would sign
 * every logged-in operator and merchant out at deploy time.
 *
 * They are accepted once and pulled into a fresh tracked family — with the new
 * DB status/role check applied, so the security fix still bites. Reuse
 * DETECTION is what they miss.
 *
 * Set ALLOW_UNTRACKED_REFRESH_TOKENS=false once 7 days have passed since the
 * deploy; after that every live refresh token is tracked and this grace can
 * only weaken things.
 */
const ALLOW_UNTRACKED_REFRESH =
  process.env.ALLOW_UNTRACKED_REFRESH_TOKENS !== 'false';

/**
 * Two tabs (or an SDK retry) can submit the same refresh token milliseconds
 * apart. Treating that as theft would sign real users out for using two
 * windows, so a re-presentation within this window is served from the same
 * family instead of revoking it. Beyond it, reuse is reuse.
 */
const REUSE_GRACE_MS = 10_000;

/**
 * `refresh_tokens` arrives in migration 023. If the code is deployed first, a
 * hard failure here would break BOTH login and refresh — a total dashboard
 * outage caused by a hardening change. The first undefined_table demotes this
 * process to untracked mode (exactly the old behaviour, plus the DB re-check
 * that is the main fix) and logs at ERROR. Restart after applying 023.
 */
let refreshTokensTable = true;

function isMissingTable(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01';
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaToken: z.string().optional(),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role_name: string;
  status: string;
  mfa_enabled: boolean;
  mfa_secret: string | null;
  email_verified: boolean;
  client_status: string | null;
}

router.post(
  '/login',
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, mfaToken } = LoginSchema.parse(req.body);

    const user = await queryOne<UserRow>(
      `SELECT u.id, u.email, u.password_hash, r.name AS role_name,
              u.status, u.mfa_enabled, u.mfa_secret, u.email_verified,
              c.status::text AS client_status
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN clients c ON c.user_id = u.id
        WHERE u.email = $1`,
      [email],
    );

    // Uniform failure to avoid user enumeration.
    if (!user || user.status !== 'active') {
      throw AppError.unauthorized('Invalid credentials');
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw AppError.unauthorized('Invalid credentials');
    }

    // MFA: enforced for ANY account with it enabled, admin or merchant.
    //
    // The misconfigured case (enabled, but no secret to verify against) used to
    // be fatal for admins and a silent fall-through to password-only for
    // merchants. Both accounts asked for a second factor; neither can present
    // one; the only honest answer is to refuse the login rather than to quietly
    // hand out tokens on one factor. Unreachable today either way — see the
    // note above `verifyMfaToken` — but it is the branch that decides what
    // happens on the day enrolment ships, and fail-open is the wrong default to
    // leave lying there.
    if (user.mfa_enabled) {
      if (!user.mfa_secret) {
        throw AppError.unauthorized('MFA misconfigured; contact support');
      }
      if (!mfaToken) {
        // Signal the client to collect a TOTP without issuing tokens.
        res.status(200).json({ mfaRequired: true });
        return;
      }
      await verifyMfaToken(user.id, user.mfa_secret, mfaToken);
    }

    const claims = { sub: user.id, role: user.role_name, email: user.email };
    const accessToken = signAccessToken(claims);
    const refreshToken = signRefreshToken(claims);

    // Start a new token family for this login. Failure here is logged, never
    // fatal: an untracked token still works (see ALLOW_UNTRACKED_REFRESH), and
    // refusing to log a user in because an audit row would not insert is the
    // wrong trade.
    await storeRefreshToken(user.id, refreshToken, null);

    await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await writeAudit({
      actorUserId: user.id,
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      ip: req.ip,
    });

    // A self-registered merchant who has not clicked the verification link can
    // still sign in — they land on a "confirm your email" screen with a resend
    // button rather than a dead end. They cannot transact: the client row is
    // still `pending`, which `requireApprovedClient` rejects.
    res.status(200).json({
      accessToken,
      refreshToken,
      mfaRequired: false,
      emailVerified: user.email_verified,
      clientStatus: user.client_status,
    });
  }),
);

const RefreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post(
  '/refresh',
  // /login has been rate limited all along; /refresh was not, even though it
  // takes a bearer credential and mints two more.
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { refreshToken } = RefreshSchema.parse(req.body);
    let payload;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      throw AppError.unauthorized('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw AppError.unauthorized('Not a refresh token');
    }

    // Consume the presented token BEFORE minting anything, so a replay of it
    // can never race a rotation.
    const familyId = await consumeRefreshToken(refreshToken, payload.sub, req.ip);

    // The claims come from the database, not from the token. This is the whole
    // fix: status and role are re-read on every rotation.
    const user = await queryOne<{
      id: string;
      email: string;
      role_name: string;
      status: string;
    }>(
      `SELECT u.id, u.email, r.name AS role_name, u.status
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [payload.sub],
    );

    if (!user || user.status !== 'active') {
      // The holder is suspended (or the row is gone). Kill the family too, so
      // they cannot keep presenting the sibling tokens they already hold.
      if (familyId) {
        await revokeFamily(familyId, 'user_not_active');
      }
      logger.warn(
        { userId: payload.sub, status: user?.status ?? 'missing' },
        'refresh rejected: user is not active',
      );
      throw AppError.unauthorized('Session is no longer valid; sign in again');
    }

    const claims = { sub: user.id, role: user.role_name, email: user.email };
    const accessToken = signAccessToken(claims);
    const nextRefresh = signRefreshToken(claims);
    await storeRefreshToken(user.id, nextRefresh, familyId);

    res.status(200).json({
      accessToken,
      refreshToken: nextRefresh,
      mfaRequired: false,
    });
  }),
);

// ---------------------------------------------------------------------------
// MFA
// ---------------------------------------------------------------------------

/**
 * A TOTP code is valid for its 30-second step plus `window: 1` on either side,
 * so roughly 90 seconds. Burn it for longer than that and a code cannot be
 * presented twice within its own lifetime.
 */
const MFA_CODE_TTL_SECONDS = 180;

/**
 * Verify one TOTP code and consume it.
 *
 * NOTE ON REACHABILITY: nothing in this product writes `users.mfa_enabled` or
 * `users.mfa_secret` — there is no enrolment route, nothing in seed, nothing in
 * the admin panel — so this function cannot run today. It is written to be
 * correct for the release that adds enrolment rather than left as a
 * single-use-free verifier for that release to inherit.
 *
 * Single use matters here for the same reason it does for HMAC signatures: a
 * code shoulder-surfed, phished or captured from a support chat stays valid for
 * a minute and a half, and without a burn it can be spent as many times as the
 * attacker likes inside that window. Fails OPEN on a Redis error — a cache blip
 * must not lock every operator out of the dashboard — and logs at ERROR.
 */
async function verifyMfaToken(
  userId: string,
  encryptedSecret: string,
  token: string,
): Promise<void> {
  const secret = decrypt(encryptedSecret);
  const verified = speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1,
  });
  if (!verified) {
    throw AppError.unauthorized('Invalid MFA token');
  }

  // Burned only AFTER a successful verify, so a wrong guess cannot be used to
  // consume the code the legitimate user is about to type.
  try {
    const first = await redis.set(
      `mfa:used:${userId}:${sha256Hex(token)}`,
      '1',
      'EX',
      MFA_CODE_TTL_SECONDS,
      'NX',
    );
    if (first === null) {
      throw AppError.unauthorized(
        'That MFA code has already been used. Wait for your authenticator to ' +
          'show the next one.',
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error(
      { err, userId },
      'MFA replay cache unavailable; accepting the code on TOTP validity alone',
    );
  }
}

// ---------------------------------------------------------------------------
// refresh_tokens (migration 023)
// ---------------------------------------------------------------------------

interface RefreshRow {
  id: string;
  family_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
}

/**
 * Atomically claim the presented token. Returns the family it belongs to, or
 * null when the token is untracked (pre-023 / pre-deploy) and the grace above
 * allows it — the caller then starts a new family.
 *
 * Throws 401 for revoked, expired, or reused tokens. Reuse revokes the family.
 */
async function consumeRefreshToken(
  token: string,
  userId: string,
  ip: string | undefined,
): Promise<string | null> {
  if (!refreshTokensTable) return null;

  const tokenHash = sha256Hex(token);

  try {
    // One UPDATE, so two concurrent refreshes cannot both claim the row: the
    // second blocks on the row lock, re-evaluates `used_at IS NULL` under READ
    // COMMITTED, matches nothing, and falls through to the grace check below.
    const claimed = await queryOne<{ family_id: string }>(
      `UPDATE refresh_tokens
          SET used_at = now()
        WHERE token_hash = $1
          AND used_at    IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING family_id`,
      [tokenHash],
    );
    if (claimed) return claimed.family_id;

    const existing = await queryOne<RefreshRow>(
      `SELECT id, family_id, used_at, revoked_at, expires_at
         FROM refresh_tokens
        WHERE token_hash = $1`,
      [tokenHash],
    );

    if (!existing) {
      if (!ALLOW_UNTRACKED_REFRESH) {
        throw AppError.unauthorized('Session is no longer valid; sign in again');
      }
      logger.warn(
        { userId },
        'refresh token has no refresh_tokens row (pre-023 token or rolling ' +
          'deploy); accepting once and adopting it into a tracked family',
      );
      return null;
    }

    if (existing.revoked_at) {
      throw AppError.unauthorized(
        'This session was revoked. Sign in again.',
      );
    }
    if (existing.expires_at.getTime() <= Date.now()) {
      throw AppError.unauthorized('Refresh token expired; sign in again');
    }

    // used_at is set. Within the grace window this is a double submit from the
    // same person (two tabs, an SDK retry); beyond it, someone is replaying a
    // token that was already spent, and the only safe reading is theft.
    const usedAgoMs = Date.now() - (existing.used_at?.getTime() ?? 0);
    if (usedAgoMs <= REUSE_GRACE_MS) {
      return existing.family_id;
    }

    await revokeFamily(existing.family_id, 'reuse_detected');
    await writeAudit({
      actorUserId: userId,
      actorType: 'system',
      action: 'auth.refresh_reuse_detected',
      entityType: 'user',
      entityId: userId,
      metadata: { familyId: existing.family_id },
      ip,
    });
    logger.error(
      { userId, familyId: existing.family_id },
      'refresh token reuse detected; revoked the whole token family',
    );
    throw AppError.unauthorized(
      'Refresh token reuse detected. Every session for this login has been ' +
        'revoked as a precaution — sign in again.',
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isMissingTable(err)) {
      refreshTokensTable = false;
      logger.error(
        { err },
        'refresh_tokens is missing (migration 023 not applied); refresh tokens ' +
          'are NOT revocable until it is applied and the API restarts',
      );
      return null;
    }
    throw err;
  }
}

/**
 * Persist the hash of a freshly minted refresh token. `familyId` null starts a
 * new family (login, or adopting an untracked token).
 *
 * Never throws: a tracking failure must not cost the user their login. The
 * consequence of a lost row is an untracked token, which behaves exactly as
 * every token did before this change.
 */
async function storeRefreshToken(
  userId: string,
  token: string,
  familyId: string | null,
): Promise<void> {
  if (!refreshTokensTable) return;
  try {
    await query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4)
       ON CONFLICT (token_hash) DO NOTHING`,
      [userId, familyId, sha256Hex(token), refreshExpiryOf(token)],
    );

    // Bounded, deterministic housekeeping: only this user's already-dead rows,
    // only on a path they just walked. Nothing else prunes this table, so
    // without it a busy operator accumulates a row every 15 minutes forever.
    // Rows for users who never come back are left to an operator sweep —
    // `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '30 days'`.
    await query(
      `DELETE FROM refresh_tokens
        WHERE user_id = $1
          AND expires_at < now() - interval '1 day'`,
      [userId],
    );
  } catch (err) {
    if (isMissingTable(err)) {
      refreshTokensTable = false;
      logger.error(
        { err },
        'refresh_tokens is missing (migration 023 not applied); issued refresh ' +
          'token is untracked and cannot be revoked',
      );
      return;
    }
    logger.error({ err, userId }, 'failed to record refresh token');
  }
}

async function revokeFamily(familyId: string, reason: string): Promise<void> {
  try {
    await query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE family_id = $1
          AND revoked_at IS NULL`,
      [familyId],
    );
    logger.warn({ familyId, reason }, 'refresh token family revoked');
  } catch (err) {
    if (isMissingTable(err)) {
      refreshTokensTable = false;
      return;
    }
    logger.error({ err, familyId, reason }, 'failed to revoke refresh token family');
  }
}

/**
 * The token's own `exp` claim, so the row expires exactly when the JWT does and
 * JWT_REFRESH_EXPIRES_IN stays the single source of truth. Falls back to 7 days
 * (the configured default) if a token somehow carries no exp.
 */
function refreshExpiryOf(token: string): Date {
  try {
    const decoded = verifyToken(token) as unknown as { exp?: number };
    if (decoded.exp) return new Date(decoded.exp * 1000);
  } catch {
    /* fall through */
  }
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

export default router;
