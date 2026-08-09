/**
 * Dashboard JWT authentication (admins + merchants).
 *
 * Access tokens carry { sub, role, email }. `requireRole(...roles)` gates admin/ops
 * endpoints. super_admin passes every role check.
 */
import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { AppError } from '../utils/apiError';

export interface JwtPayload {
  sub: string;
  role: string;
  email: string;
  type: 'access' | 'refresh';
}

export function signAccessToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: Omit<JwtPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'refresh' }, config.jwt.secret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwt.secret) as JwtPayload;
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
    req.user = { userId: decoded.sub, role: decoded.role, email: decoded.email };
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
