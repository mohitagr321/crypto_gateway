/**
 * Public merchant self-registration, email verification and password reset.
 *
 * Mounted under /auth alongside routes/auth.ts (login/refresh):
 *   GET  /auth/signup-status        is self-registration open?
 *   POST /auth/register             create an UNVERIFIED account
 *   POST /auth/verify-email         consume the emailed token -> approved + signed in
 *   POST /auth/resend-verification  re-send the link
 *   POST /auth/forgot-password      send a reset link
 *   POST /auth/reset-password       consume the reset token
 *
 * ============================ THE APPROVAL MODEL =============================
 * Registration writes `clients.status = 'pending'` and an unverified user. It
 * mints NO API key. Verifying the email flips the client to 'approved' with
 * `approved_by = NULL` (nobody approved it — the email proved itself) and signs
 * the merchant in. The API key comes later, from the dashboard, after a payout
 * wallet exists — so a merchant can never end up with live credentials and
 * nowhere to settle. An operator can still suspend from the admin panel at any
 * point, and SIGNUP_ENABLED=false closes the door entirely.
 *
 * ============================ ENUMERATION SAFETY =============================
 * None of these routes reveal whether an address has an account. Register,
 * resend and forgot-password all return the SAME 202 and the same message
 * regardless; the difference is delivered only to the inbox that owns the
 * address (a verification link, a reset link, or a "you already have an
 * account" notice). This is why register does not return 409 on a duplicate.
 *
 * ============================== RATE LIMITING ================================
 * Split by what the route actually does, because one shared bucket locked
 * legitimate merchants out of activating their own account:
 *   - Routes that SEND mail (register, resend, forgot-password) use the strict
 *     `signupRateLimiter` — a few per IP per hour. They deliver to an
 *     attacker-chosen address, so they are a spam relay if left open.
 *   - Routes that CONSUME a token (verify-email, reset-password) use the normal
 *     `authRateLimiter`. They send nothing, and guessing a 256-bit single-use
 *     token is not a threat worth throttling a shared office IP over.
 */
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PoolClient } from 'pg';
import { asyncHandler, AppError } from '../utils/apiError';
import { query, queryOne, withTransaction } from '../db/pool';
import { encrypt, randomToken } from '../utils/crypto';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { signAccessToken, signRefreshToken } from '../middleware/jwtAuth';
import { authRateLimiter, signupRateLimiter } from '../middleware/rateLimit';
import { writeAudit } from '../services/auditService';
import { issueToken, consumeToken } from '../services/userTokenService';
import {
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendDuplicateSignupEmail,
} from '../services/emailService';

const router = Router();

/**
 * With signup disabled the whole surface behaves as if it were never deployed —
 * 404, not 403, so a closed gateway does not advertise that the feature exists.
 */
function requireSignupEnabled(_req: Request, _res: Response, next: NextFunction): void {
  if (!config.signup.enabled) {
    next(AppError.notFound('Self-registration is not enabled on this gateway'));
    return;
  }
  next();
}

/** The uniform, enumeration-safe acknowledgement. */
const ACCEPTED = {
  success: true,
  message:
    'If that email can be registered, we have sent a message to it. ' +
    'Check your inbox (and spam folder).',
};

// ---------- GET /auth/signup-status ----------
// Unauthenticated and un-rate-limited: the panel calls it on every page load to
// decide whether to render signup links at all.

router.get('/signup-status', (_req: Request, res: Response) => {
  res.status(200).json({ enabled: config.signup.enabled });
});

// ---------- POST /auth/register ----------

const RegisterSchema = z.object({
  email: z.string().email().max(320),
  // 10 chars is the floor for a credential that guards a balance. The panel
  // shows a strength meter over the same rule.
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
  businessName: z.string().min(2, 'Business name is required').max(120),
  // `.url()` alone is NOT enough: it accepts `javascript:alert(1)`, and the
  // admin panel renders this value as a clickable link on the client detail
  // page. That would be a stored XSS against an operator's session. Restrict to
  // real web URLs at the only point where the value can enter the system.
  websiteUrl: z
    .string()
    .url()
    .max(500)
    .refine(
      (v) => /^https?:\/\//i.test(v),
      'Website must start with http:// or https://',
    )
    .optional()
    .or(z.literal('')),
  country: z.string().max(80).optional().or(z.literal('')),
});

router.post(
  '/register',
  requireSignupEnabled,
  signupRateLimiter,
  asyncHandler(async (req, res) => {
    const body = RegisterSchema.parse(req.body);
    const email = body.email.trim().toLowerCase();

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );

    if (existing) {
      // Do NOT 409 — that would confirm the address is registered. Tell the real
      // owner instead, and hand the caller the same 202 everyone else gets.
      void sendDuplicateSignupEmail({ to: email }).catch(() => undefined);
      await writeAudit({
        actorUserId: null,
        actorType: 'system',
        action: 'auth.register_duplicate',
        entityType: 'user',
        entityId: existing.id,
        ip: req.ip,
      });
      res.status(202).json(ACCEPTED);
      return;
    }

    const created = await withTransaction(async (tx: PoolClient) => {
      const roleRes = await tx.query<{ id: number }>(
        `SELECT id FROM roles WHERE name = 'merchant'`,
      );
      if (roleRes.rowCount === 0) {
        throw AppError.internal('merchant role missing; run schema.sql');
      }

      const passwordHash = await bcrypt.hash(body.password, 12);
      let userId: string;
      try {
        const userRes = await tx.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role_id, status, email_verified)
           VALUES ($1, $2, $3, 'active', false)
           RETURNING id`,
          [email, passwordHash, roleRes.rows[0].id],
        );
        userId = userRes.rows[0].id;
      } catch (err) {
        // Lost the race against a concurrent signup for the same address. The
        // unique index is the real guard; treat it exactly like the duplicate
        // branch above so the response stays uniform.
        if ((err as { code?: string }).code === '23505') return null;
        throw err;
      }

      const clientRes = await tx.query<{ id: string }>(
        `INSERT INTO clients
           (user_id, business_name, status, webhook_secret, website_url, country,
            signup_source)
         VALUES ($1, $2, 'pending', $3, $4, $5, 'self')
         RETURNING id`,
        [
          userId,
          body.businessName.trim(),
          encrypt(randomToken(24)), // per-client webhook HMAC secret
          body.websiteUrl || null,
          body.country || null,
        ],
      );
      const clientId = clientRes.rows[0].id;

      // Give the merchant a real commission from minute one. Inserted inline
      // rather than via setCommission() because that helper opens its own
      // transaction — signup must be one atomic unit.
      await tx.query(
        `INSERT INTO commissions
           (client_id, type, value, network_fee_payer, is_active, created_by)
         VALUES ($1, 'percentage', $2, 'client', true, NULL)`,
        [clientId, config.signup.defaultCommissionPercent],
      );

      const token = await issueToken(
        userId,
        'email_verify',
        config.signup.verifyTtlHours * 60 * 60 * 1000,
        tx,
      );

      await writeAudit(
        {
          actorUserId: userId,
          actorType: 'user',
          action: 'auth.register',
          entityType: 'client',
          entityId: clientId,
          metadata: { email, businessName: body.businessName, source: 'self' },
          ip: req.ip,
        },
        tx,
      );

      return { userId, clientId, token };
    });

    if (created) {
      // Outside the transaction: a slow or dead SMTP server must not roll back a
      // committed signup. sendVerificationEmail never throws; a false is logged
      // by the service and the merchant can use "resend".
      await sendVerificationEmail({
        to: email,
        businessName: body.businessName.trim(),
        token: created.token,
      });
      logger.info({ clientId: created.clientId }, 'merchant self-registered');
    }

    res.status(202).json(ACCEPTED);
  }),
);

// ---------- POST /auth/verify-email ----------

const TokenSchema = z.object({ token: z.string().min(1).max(200) });

router.post(
  '/verify-email',
  requireSignupEnabled,
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { token } = TokenSchema.parse(req.body);

    const result = await withTransaction(async (tx: PoolClient) => {
      const userId = await consumeToken(token, 'email_verify', tx);
      if (!userId) return null;

      const userRes = await tx.query<{
        id: string;
        email: string;
        role_name: string;
      }>(
        `UPDATE users u
            SET email_verified = true, updated_at = now()
           FROM roles r
          WHERE u.id = $1 AND r.id = u.role_id
          RETURNING u.id, u.email, r.name AS role_name`,
        [userId],
      );
      const user = userRes.rows[0];
      if (!user) return null;

      // Approve only from 'pending'. A suspended or rejected merchant who clicks
      // an old link must stay suspended — verification proves an address, not
      // good standing.
      const clientRes = await tx.query<{ id: string; status: string }>(
        `UPDATE clients
            SET status = 'approved', approved_at = now(), updated_at = now()
          WHERE user_id = $1 AND status = 'pending'
          RETURNING id, status`,
        [userId],
      );
      const client = clientRes.rows[0] ?? null;

      if (client) {
        await writeAudit(
          {
            actorUserId: userId,
            actorType: 'system',
            action: 'client.self_approve',
            entityType: 'client',
            entityId: client.id,
            metadata: { reason: 'email_verified' },
            ip: req.ip,
          },
          tx,
        );
      }

      return { user, clientId: client?.id ?? null };
    });

    if (!result) {
      throw AppError.badRequest(
        'This verification link is invalid, already used, or expired. Request a new one.',
      );
    }

    const claims = {
      sub: result.user.id,
      role: result.user.role_name,
      email: result.user.email,
    };

    // Best-effort welcome; never blocks the response.
    const businessName = await queryOne<{ business_name: string }>(
      `SELECT business_name FROM clients WHERE user_id = $1`,
      [result.user.id],
    );
    void sendWelcomeEmail({
      to: result.user.email,
      businessName: businessName?.business_name ?? 'there',
    }).catch(() => undefined);

    res.status(200).json({
      accessToken: signAccessToken(claims),
      refreshToken: signRefreshToken(claims),
      mfaRequired: false,
      emailVerified: true,
    });
  }),
);

// ---------- POST /auth/resend-verification ----------

const EmailSchema = z.object({ email: z.string().email().max(320) });

router.post(
  '/resend-verification',
  requireSignupEnabled,
  signupRateLimiter,
  asyncHandler(async (req, res) => {
    const { email } = EmailSchema.parse(req.body);
    const normalized = email.trim().toLowerCase();

    const user = await queryOne<{
      id: string;
      email: string;
      email_verified: boolean;
      business_name: string | null;
    }>(
      `SELECT u.id, u.email, u.email_verified, c.business_name
         FROM users u
         LEFT JOIN clients c ON c.user_id = u.id
        WHERE u.email = $1 AND u.status = 'active'`,
      [normalized],
    );

    // Silent no-op for unknown or already-verified addresses — same response.
    if (user && !user.email_verified) {
      const token = await issueToken(
        user.id,
        'email_verify',
        config.signup.verifyTtlHours * 60 * 60 * 1000,
      );
      await sendVerificationEmail({
        to: user.email,
        businessName: user.business_name ?? 'there',
        token,
      });
    }

    res.status(202).json(ACCEPTED);
  }),
);

// ---------- POST /auth/forgot-password ----------
// Deliberately NOT behind requireSignupEnabled: a gateway that has closed
// registration still has merchants who forget passwords.

router.post(
  '/forgot-password',
  signupRateLimiter,
  asyncHandler(async (req, res) => {
    const { email } = EmailSchema.parse(req.body);
    const normalized = email.trim().toLowerCase();

    const user = await queryOne<{ id: string; email: string }>(
      `SELECT id, email FROM users WHERE email = $1 AND status = 'active'`,
      [normalized],
    );

    if (user) {
      const token = await issueToken(
        user.id,
        'password_reset',
        config.signup.resetTtlMinutes * 60 * 1000,
      );
      await sendPasswordResetEmail({ to: user.email, token });
      await writeAudit({
        actorUserId: user.id,
        actorType: 'user',
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        ip: req.ip,
      });
    }

    res.status(202).json(ACCEPTED);
  }),
);

// ---------- POST /auth/reset-password ----------

const ResetSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

router.post(
  '/reset-password',
  authRateLimiter,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = ResetSchema.parse(req.body);

    const userId = await withTransaction(async (tx: PoolClient) => {
      const id = await consumeToken(token, 'password_reset', tx);
      if (!id) return null;

      const hash = await bcrypt.hash(newPassword, 12);
      await tx.query(
        `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`,
        [id, hash],
      );

      // Proving control of the inbox is at least as strong as clicking the
      // verification link, so a reset also verifies the address. Without this a
      // merchant who never clicked the original link could reset their password
      // and still be stuck unverified.
      await tx.query(`UPDATE users SET email_verified = true WHERE id = $1`, [id]);

      await writeAudit(
        {
          actorUserId: id,
          actorType: 'user',
          action: 'auth.password_reset',
          entityType: 'user',
          entityId: id,
          ip: req.ip,
        },
        tx,
      );
      return id;
    });

    if (!userId) {
      throw AppError.badRequest(
        'This reset link is invalid, already used, or expired. Request a new one.',
      );
    }

    // Invalidate any outstanding verification token too — the account is now
    // verified, so a stale link should not remain clickable.
    await query(
      `UPDATE user_tokens SET used_at = now()
        WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );

    res.status(200).json({ success: true });
  }),
);

export default router;
