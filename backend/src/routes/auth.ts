/**
 * Auth routes: dashboard login (merchant + admin) and token refresh.
 *
 * Admins (any role != merchant) with MFA enabled must present a valid TOTP token.
 * Returns { accessToken, refreshToken, mfaRequired }.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { z } from 'zod';
import { asyncHandler, AppError } from '../utils/apiError';
import { query, queryOne } from '../db/pool';
import { decrypt } from '../utils/crypto';
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
} from '../middleware/jwtAuth';
import { authRateLimiter } from '../middleware/rateLimit';
import { writeAudit } from '../services/auditService';

const router = Router();

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

    const isAdmin = user.role_name !== 'merchant';

    // MFA: required for admins that have it enabled.
    if (user.mfa_enabled && user.mfa_secret) {
      if (!mfaToken) {
        // Signal the client to collect a TOTP without issuing tokens.
        res.status(200).json({ mfaRequired: true });
        return;
      }
      const secret = decrypt(user.mfa_secret);
      const verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: mfaToken,
        window: 1,
      });
      if (!verified) {
        throw AppError.unauthorized('Invalid MFA token');
      }
    } else if (isAdmin && user.mfa_enabled && !user.mfa_secret) {
      throw AppError.unauthorized('MFA misconfigured; contact support');
    }

    const claims = { sub: user.id, role: user.role_name, email: user.email };
    const accessToken = signAccessToken(claims);
    const refreshToken = signRefreshToken(claims);

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
    const claims = { sub: payload.sub, role: payload.role, email: payload.email };
    res.status(200).json({
      accessToken: signAccessToken(claims),
      refreshToken: signRefreshToken(claims),
      mfaRequired: false,
    });
  }),
);

export default router;
