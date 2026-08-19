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
import type { Request, Response } from 'express';
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
import { authRateLimiter, loginPollLimiter } from '../middleware/rateLimit';
import { writeAudit } from '../services/auditService';
import { config } from '../config/env';
import { parseUserAgent, formatIp } from '../utils/deviceInfo';
import { sendLoginApprovalEmail, mailTransport } from '../services/emailService';
import {
  createApproval,
  findByActionToken,
  decide,
  pollStatus,
  consume,
} from '../services/loginApprovalService';
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

    // ---------------------------------------------------------------------
    // THE PASSWORD IS NOT THE END OF THE FLOW.
    //
    // Everything above proves possession of the password (and of the second
    // factor, where one exists). That now buys a PENDING REQUEST and an email
    // to the address on the account — not a session. See
    // sql/migrations/027_login_approvals.sql for why, and for why the emailed
    // link cannot itself hand out tokens.
    //
    // Order matters here: the approval row is written and the mail is sent only
    // AFTER the credentials check. Sending first would make this endpoint an
    // email bomb aimed at any address an attacker cares to type, and the
    // presence or absence of the mail would leak which accounts exist.
    // ---------------------------------------------------------------------
    if (config.loginApproval.enabled) {
      const panel = user.role_name === 'merchant' ? 'merchant' : 'admin';
      const device = parseUserAgent(req.get('user-agent'));
      const ip = formatIp(req.ip);

      const { challenge, actionToken, expiresAt } = await createApproval({
        userId: user.id,
        ip,
        userAgent: req.get('user-agent') ?? null,
        device,
        panel,
      });

      // The link's HOST is chosen from the user's ROLE, never from anything in
      // the request. A `panel` field in the body would be an attacker-supplied
      // string interpolated into a URL inside an email we sign with our own
      // domain, which is a phishing kit with extra steps.
      const sent = await sendLoginApprovalEmail({
        to: user.email,
        panelUrl:
          panel === 'admin'
            ? config.loginApproval.adminUrl
            : config.loginApproval.panelUrl,
        token: actionToken,
        deviceLabel: device.label,
        deviceKind: device.kind,
        ip,
        at: new Date(),
        minutes: config.loginApproval.ttlMinutes,
      });

      await writeAudit({
        actorUserId: user.id,
        action: 'auth.login_requested',
        entityType: 'user',
        entityId: user.id,
        ip: req.ip,
        metadata: { device: device.label, kind: device.kind, mailSent: sent },
      });

      // A FALSE RETURN MEANS TWO DIFFERENT THINGS, and conflating them breaks
      // local development completely.
      //
      // With a real transport configured, false is a genuine delivery failure:
      // the mail transport is load-bearing for authentication now, so reporting
      // success would leave the browser polling for an approval link that
      // nobody will ever receive. That has to be an explicit error.
      //
      // In LOG mode there is no transport by design — emailService renders the
      // message to the log, returns false, and the whole signup flow is already
      // documented as walkable that way by copying the link out of the console.
      // Treating that as an outage would make it impossible to sign in at all
      // on a developer machine. Production cannot reach this branch: the
      // superRefine in config/env.ts refuses to boot with this feature enabled
      // and no transport.
      if (!sent && mailTransport() !== 'log') {
        throw AppError.internal(
          'Could not send the approval email. Try again, or contact support if this persists.',
        );
      }

      res.status(200).json({
        approvalRequired: true,
        challenge,
        expiresAt: expiresAt.toISOString(),
        // Masked so the pending screen can say WHICH inbox to open without
        // printing the full address on a screen an attacker may be looking at.
        sentTo: maskEmail(user.email),
        mfaRequired: false,
      });
      return;
    }

    await issueSession(req, res, {
      id: user.id,
      email: user.email,
      role_name: user.role_name,
      email_verified: user.email_verified,
      client_status: user.client_status,
    });
  }),
);

/**
 * "m****t@example.com" — enough for the account holder to recognise their own
 * inbox, not enough to be useful to somebody reading over their shoulder.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1);
  const tail = local.length > 1 ? local.slice(-1) : '';
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}${tail}@${domain}`;
}

/**
 * Mint the session and reply. The single place tokens are issued for a
 * password login, reached either directly (approval disabled) or from the
 * collect step once an approval lands — so the two paths cannot drift in what
 * they set up or what they return.
 */
async function issueSession(
  req: Request,
  res: Response,
  user: {
    id: string;
    email: string;
    role_name: string;
    email_verified: boolean;
    client_status: string | null;
  },
  /**
   * The device to record against this session. Supplied by the approval path,
   * which captured it on the LOGIN request — the same request the approval
   * email described. Omitted on the direct path, where this request IS the
   * login and its own headers are the right source.
   */
  recorded?: { label: string | null; kind: string | null; ip: string | null; userAgent: string | null },
): Promise<void> {
  const parsed = parseUserAgent(req.get('user-agent'));
  const device = {
    label: recorded?.label ?? parsed.label,
    kind: recorded?.kind ?? parsed.kind,
    ip: recorded?.ip ?? formatIp(req.ip),
    userAgent: recorded?.userAgent ?? req.get('user-agent') ?? null,
  };
  const refreshToken = signRefreshToken({
    sub: user.id,
    role: user.role_name,
    email: user.email,
  });

  // Start a new token family for this login, tagged with the device that opened
  // it. Failure here is logged, never fatal: an untracked token still works
  // (see ALLOW_UNTRACKED_REFRESH), and refusing to log a user in because an
  // audit row would not insert is the wrong trade.
  const familyId = await storeRefreshToken(user.id, refreshToken, null, device);

  // THE FAMILY ID TRAVELS IN THE ACCESS TOKEN, which is what lets the session
  // list mark one row "this device". It is an identifier, not a credential:
  // knowing it permits nothing, and the revoke endpoint authorises against the
  // authenticated user rather than against this value. Absent on tokens minted
  // before this shipped, so the panel degrades to marking nothing rather than
  // marking the wrong row.
  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role_name,
    email: user.email,
    ...(familyId ? { fid: familyId } : {}),
  });

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
}

/* ==========================================================================
 * LOGIN APPROVAL
 *
 * Three endpoints, and the split between them is the security model rather
 * than tidiness:
 *
 *   GET  /login/request   read-only, takes the EMAIL token. Renders the
 *                         decision page. Safe for a mail scanner to fetch,
 *                         because it changes nothing.
 *   POST /login/decision  takes the EMAIL token. Approves or rejects. POST so
 *                         that a scanner following links cannot trigger it.
 *   POST /login/collect   takes the BROWSER challenge. Polls, and mints the
 *                         session once the answer is "approved".
 *
 * Neither token can do the other's job. See the 027 migration.
 * ======================================================================== */

const ActionTokenSchema = z.object({ token: z.string().min(1).max(200) });
const DecisionSchema = ActionTokenSchema.extend({
  decision: z.enum(['approve', 'reject']),
});
const ChallengeSchema = z.object({ challenge: z.string().min(1).max(200) });

/**
 * What the approval page shows. Deliberately NOT the email address or anything
 * else about the account: this endpoint is reachable by anyone holding the
 * link, and the link travels through mail servers. It answers "what am I being
 * asked to approve", nothing more.
 */
router.get(
  '/login/request',
  authRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = ActionTokenSchema.parse(req.query);
    const row = await findByActionToken(token);

    if (!row) {
      throw AppError.notFound('This approval link is not valid.');
    }

    // An expired row still reports its real status so the page can distinguish
    // "you already approved this" from "this timed out", which are different
    // things for a reader deciding whether to worry.
    const expired = row.status === 'pending' && row.expires_at.getTime() <= Date.now();

    res.status(200).json({
      status: expired ? 'expired' : row.status,
      device: row.device_label,
      deviceKind: row.device_kind,
      ip: row.ip,
      panel: row.panel,
      requestedAt: row.created_at,
      expiresAt: row.expires_at,
    });
  }),
);

/**
 * The decision. POST-only, and that is load-bearing: Gmail, Outlook and most
 * corporate mail gateways fetch the links in a message to scan them, so a GET
 * that approved would be approved by a robot within seconds of delivery,
 * before the account holder ever saw it.
 *
 * `decide` resolves the race in SQL — a double-tap, or an approve in one tab
 * against a reject in another, produces exactly one winner and the loser gets
 * null.
 */
router.post(
  '/login/decision',
  authRateLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { token, decision } = DecisionSchema.parse(req.body);
    const wanted = decision === 'approve' ? 'approved' : 'rejected';

    const row = await decide(token, wanted);
    if (!row) {
      // Already answered, expired, or never existed. All three collapse to one
      // message: telling the holder of a link WHICH it was would let them probe
      // for live requests.
      throw AppError.badRequest('This request has already been answered or has expired.');
    }

    await writeAudit({
      actorUserId: row.user_id,
      action: decision === 'approve' ? 'auth.login_approved' : 'auth.login_rejected',
      entityType: 'user',
      entityId: row.user_id,
      ip: req.ip,
      metadata: { device: row.device_label, requestIp: row.ip },
    });

    if (decision === 'reject') {
      logger.warn(
        { userId: row.user_id, requestIp: row.ip, device: row.device_label },
        'login attempt rejected by account holder',
      );
    }

    res.status(200).json({ status: wanted });
  }),
);

/**
 * The waiting browser's endpoint. Polled every couple of seconds while the
 * pending screen is open, so it stays cheap: one indexed lookup, and a second
 * statement only on the one poll that finds an approval.
 *
 * THE SESSION IS MINTED HERE, not at the moment of approval, and that is the
 * point of the whole two-token split — the tokens are handed to whoever proved
 * they knew the password, never to whoever opened the email. `consume` flips
 * the row to 'consumed' in the same statement that authorises it, so a
 * challenge replayed from two tabs yields one session.
 */
router.post(
  '/login/collect',
  // NOT authRateLimiter — this endpoint is polled every two seconds by a
  // browser waiting for an approval, which the auth limiter would cut off
  // within the first fifteen seconds. See the note on loginPollLimiter.
  loginPollLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { challenge } = ChallengeSchema.parse(req.body);
    const status = await pollStatus(challenge);

    if (status !== 'approved') {
      // 200 for every non-approved state: this is a poll, and a browser polling
      // a pending request every two seconds should not be generating a stream
      // of 4xx in the logs of a security-relevant endpoint.
      res.status(200).json({ status });
      return;
    }

    const claimed = await consume(challenge);
    if (!claimed) {
      // Lost a race with another tab, or the row aged out between the two
      // statements. Both mean there is no session to hand over.
      res.status(200).json({ status: 'expired' });
      return;
    }

    const user = await queryOne<{
      id: string;
      email: string;
      role_name: string;
      status: string;
      email_verified: boolean;
      client_status: string | null;
    }>(
      `SELECT u.id, u.email, r.name AS role_name, u.status, u.email_verified,
              c.status::text AS client_status
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN clients c ON c.user_id = u.id
        WHERE u.id = $1`,
      [claimed.userId],
    );

    // Re-checked at COLLECT, not just at login. An account suspended during the
    // minutes between entering the password and approving the email must not
    // get a session out of the approval — the status check at the top of /login
    // is already stale by then.
    if (!user || user.status !== 'active') {
      throw AppError.unauthorized('This account is not active.');
    }

    await issueSession(req, res, user, claimed.device);
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
    const nextRefresh = signRefreshToken(claims);
    // No device passed: rotation INHERITS the family's original device rather
    // than re-deriving it from this request. See storeRefreshToken.
    const nextFamily = await storeRefreshToken(user.id, nextRefresh, familyId);
    const accessToken = signAccessToken({
      ...claims,
      ...(nextFamily ? { fid: nextFamily } : {}),
    });

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
  device?: { label: string; kind: string; ip: string | null; userAgent: string | null },
): Promise<string | null> {
  if (!refreshTokensTable) return null;
  try {
    // THE DEVICE DESCRIBES THE FAMILY, so a rotation inherits it rather than
    // re-deriving it. Re-parsing the User-Agent on every refresh would look
    // equivalent and is not: the same session rotating from a browser that has
    // since auto-updated would silently rename itself in the merchant's session
    // list, and a session that changes its own name is exactly the thing the
    // list exists to let someone notice.
    //
    // `COALESCE($5, prev.device_label)` reads the family's existing values when
    // the caller passes none, which is what the refresh path does.
    const rows = await query<{ family_id: string }>(
      `WITH prev AS (
         SELECT device_label, device_kind, ip, user_agent
           FROM refresh_tokens
          WHERE family_id = $2::uuid
          ORDER BY issued_at DESC
          LIMIT 1
       )
       INSERT INTO refresh_tokens
         (user_id, family_id, token_hash, expires_at,
          device_label, device_kind, ip, user_agent, last_used_at)
       SELECT $1,
              COALESCE($2::uuid, gen_random_uuid()),
              $3,
              $4,
              COALESCE($5, (SELECT device_label FROM prev)),
              COALESCE($6, (SELECT device_kind  FROM prev)),
              COALESCE($7, (SELECT ip           FROM prev)),
              COALESCE($8, (SELECT user_agent   FROM prev)),
              now()
       ON CONFLICT (token_hash) DO NOTHING
       RETURNING family_id`,
      [
        userId,
        familyId,
        sha256Hex(token),
        refreshExpiryOf(token),
        device?.label ?? null,
        device?.kind ?? null,
        device?.ip ?? null,
        device?.userAgent ?? null,
      ],
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

    return rows[0]?.family_id ?? familyId;
  } catch (err) {
    if (isMissingTable(err)) {
      refreshTokensTable = false;
      logger.error(
        { err },
        'refresh_tokens is missing (migration 023 not applied); issued refresh ' +
          'token is untracked and cannot be revoked',
      );
      return null;
    }
    logger.error({ err, userId }, 'failed to record refresh token');
  }
  return null;
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
