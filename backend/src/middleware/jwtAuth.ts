/**
 * Dashboard JWT authentication (admins + merchants).
 *
 * Access tokens carry { sub, role, email }. `requireRole(...roles)` gates admin/ops
 * endpoints. super_admin passes every role check.
 */
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env';
import { AppError } from '../utils/apiError';

export interface JwtPayload {
  sub: string;
  role: string;
  email: string;
  type: 'access' | 'refresh';
  /**
   * The refresh-token FAMILY this access token belongs to — i.e. which signed-in
   * device it came from. Present on access tokens only, and only on ones minted
   * since sessions became listable.
   *
   * IT IS AN IDENTIFIER, NOT A CREDENTIAL. It exists so the session list can
   * mark one row "this device"; every revoke authorises against the
   * authenticated user, never against this value, so a forged or copied `fid`
   * grants nothing. Optional because tokens minted before it shipped do not
   * carry one — the panel then marks no row rather than the wrong one.
   */
  fid?: string;
}

export function signAccessToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

/**
 * EVERY REFRESH TOKEN CARRIES A RANDOM `jti`, and it is load-bearing rather
 * than ceremonial.
 *
 * A JWT is a pure function of its claims. Without a unique one, two refresh
 * tokens minted for the same user inside the same SECOND are byte-identical —
 * same sub, role, email, type, iat and exp — and therefore hash identically.
 * `refresh_tokens` keys on `token_hash` with `ON CONFLICT DO NOTHING`, so the
 * second login's row is silently dropped and the two devices end up sharing one
 * credential and one family: revoking either signs out both, and reuse
 * detection can fire on an honest second device.
 *
 * That was invisible until sessions became listable — three logins in a test
 * produced one row. `jti` makes each issuance unique whatever the clock says.
 *
 * It is not read anywhere. The value is never checked, only relied on to differ;
 * the token's identity in the database is still its sha256.
 */
export function signRefreshToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign(
    { ...payload, type: 'refresh', jti: randomUUID() },
    config.jwt.secret,
    { expiresIn: config.jwt.refreshExpiresIn } as jwt.SignOptions,
  );
}

/**
 * `algorithms` is pinned rather than left to the library's inference.
 *
 * jsonwebtoken 9 already refuses `alg: none` unless it is explicitly named, and
 * defaults the accepted set to the HS family when the key material is a secret,
 * so this is not a live hole today — it is a hole one dependency bump or one
 * "let's support RS256 for the admin panel" away, and at that point an attacker
 * who knows any public key can re-sign a token as HS256 against it. Naming the
 * one algorithm we actually issue costs nothing and takes that class off the
 * table permanently.
 *
 * Issuer/audience are deliberately NOT added here: pinning them on verify while
 * live tokens (refresh tokens last 7 days) carry neither would sign every
 * operator and merchant out at deploy. Doing it needs a release that only signs
 * them, then a later release that requires them.
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
  }) as JwtPayload;
}

export function jwtAuth(req: Request, _res: Response, next: NextFunction): void {
  try {
    const authz = req.headers.authorization;
    if (!authz || !authz.startsWith('Bearer ')) {
      throw AppError.unauthorized('Missing Bearer token');
    }
    const token = authz.slice('Bearer '.length).trim();
    let decoded: JwtPayload;
    try {
      decoded = verifyToken(token);
    } catch {
      throw AppError.unauthorized('Invalid or expired token');
    }
    if (decoded.type !== 'access') {
      throw AppError.unauthorized('Not an access token');
    }
    req.user = {
      userId: decoded.sub,
      role: decoded.role,
      email: decoded.email,
      familyId: decoded.fid,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Role guard. super_admin is always allowed. Use AFTER jwtAuth.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(AppError.unauthorized());
      return;
    }
    if (req.user.role === 'super_admin' || roles.includes(req.user.role)) {
      next();
      return;
    }
    next(AppError.forbidden('Insufficient role'));
  };
}
