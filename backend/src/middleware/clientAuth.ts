/**
 * Merchant dashboard authentication for the client-panel.
 *
 * The client-panel talks to the API in two ways:
 *   1. Server-to-server integrations sign requests with an API key + HMAC
 *      (the existing `merchantAuth`, triggered by the `x-api-key` header).
 *   2. The logged-in dashboard uses a JWT access token (role 'merchant').
 *
 * `clientAuth` dispatches between the two: if `x-api-key` is present it defers
 * to `merchantAuth`; otherwise it verifies the Bearer access token, requires
 * role 'merchant', resolves the client by users.id (clients.user_id = sub) and
 * attaches `req.client`.
 *
 * `requireApprovedClient` gates routes that require an approved merchant; use it
 * AFTER `clientAuth`.
 *
 * `requireDashboardSession` gates routes that an API key must NEVER reach — see
 * its own note below.
 */
import { NextFunction, Request, Response } from 'express';
import { merchantAuth } from './auth';
import { verifyToken } from './jwtAuth';
import { queryOne } from '../db/pool';
import { AppError } from '../utils/apiError';
import { ALL_SCOPES } from '../services/apiKeyService';

export async function clientAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // API key present -> delegate to the HMAC merchant auth path.
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== undefined && apiKey !== '') {
    return merchantAuth(req, res, next);
  }

  try {
    const authz = req.headers.authorization;
    if (!authz || !authz.startsWith('Bearer ')) {
      throw AppError.unauthorized('Missing X-Api-Key or Bearer token');
    }
    const token = authz.slice('Bearer '.length).trim();

    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      throw AppError.unauthorized('Invalid or expired token');
    }
    if (decoded.type !== 'access') {
      throw AppError.unauthorized('Not an access token');
    }
    if (decoded.role !== 'merchant') {
      throw AppError.forbidden('Merchant role required');
    }

    // WHO is doing this, not just which account it happens to. `req.user` was
    // set only by jwtAuth, which is mounted on the ADMIN router alone, so on
    // every merchant route it was permanently undefined. Two things depended on
    // it and silently did nothing:
    //   - the "a new API key was created on your account" security email in
    //     routes/account.ts is guarded by `if (req.user?.email)` and could
    //     therefore never send;
    //   - a dozen writeAudit calls pass `actorUserId: req.user?.userId ?? null`
    //     while auditService stamps actor_type='user', so every merchant audit
    //     row recorded a user action with a NULL actor.
    // The decoded claims are already in hand and already verified — the client
    // lookup below is scoped by `decoded.sub` regardless, so this adds no
    // authority, only attribution. API-key requests still have no `req.user`,
    // correctly: a machine credential is not a person.
    req.user = { userId: decoded.sub, role: decoded.role, email: decoded.email };

    const client = await queryOne<{
      id: string;
      business_name: string;
      status: string;
    }>(
      `SELECT id, business_name, status FROM clients WHERE user_id = $1`,
      [decoded.sub],
    );
    if (!client) {
      throw AppError.unauthorized('No merchant account for this user');
    }

    req.client = {
      apiKeyId: null,
      clientId: client.id,
      businessName: client.business_name,
      status: client.status,
      // A logged-in owner is not a constrained machine credential; scopes exist
      // to limit API keys, so a dashboard session carries all of them.
      authMode: 'dashboard',
      scopes: [...ALL_SCOPES],
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require an approved merchant. Use AFTER `clientAuth`.
 */
export function requireApprovedClient(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.client) {
    next(AppError.unauthorized());
    return;
  }
  if (req.client.status !== 'approved') {
    next(AppError.forbidden(`Client is ${req.client.status}, not approved`));
    return;
  }
  next();
}

/**
 * Require a logged-in dashboard session — reject API keys of either mode.
 *
 * WHY THIS EXISTS: a handful of merchant routes change the account's security
 * posture rather than doing day-to-day work — where settlements are paid
 * (`PUT /account/settings` writes the payout wallet), what credentials exist
 * (`/account/api-keys*`), and the login password. Those were reachable with an
 * API key, which meant a leaked key could quietly redirect every future payout
 * to an attacker's address. That is survivable-ish when the credential is an
 * HMAC secret that never crosses the wire; it is not survivable once simple
 * bearer tokens exist.
 *
 * So: money-in and reads are API-key work. Changing where money goes is a human
 * at a keyboard, holding a short-lived access token, past login.
 *
 * NOT past MFA — this note used to say so and it was wrong. `users.mfa_enabled`
 * and `users.mfa_secret` are only ever READ (routes/auth.ts); no route, script
 * or seed writes them, so no account can have a second factor and this gate is
 * exactly one password strong. Treat that as the control you actually have.
 *
 * Use AFTER `clientAuth`.
 */
export function requireDashboardSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.client) {
    next(AppError.unauthorized());
    return;
  }
  if (req.client.authMode !== 'dashboard') {
    next(
      AppError.unauthorized(
        'This endpoint requires a signed-in dashboard session and cannot be ' +
          'called with an API key. Sign in to the merchant panel to change ' +
          'payout, credential or password settings.',
      ),
    );
    return;
  }
  next();
}
