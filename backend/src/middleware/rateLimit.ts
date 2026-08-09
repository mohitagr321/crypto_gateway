/**
 * Rate limiting via express-rate-limit, backed by Redis when available.
 *
 * If the Redis store cannot be constructed for any reason we fall back to the
 * in-memory store so the API still boots (with a warning) rather than crashing.
 */
import rateLimit, { Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { redis } from '../db/redis';

function buildStore(prefix: string): Options['store'] | undefined {
  try {
    return new RedisStore({
      // ioredis: use call() to send raw commands as rate-limit-redis expects.
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<never>,
      prefix,
    }) as unknown as Options['store'];
  } catch (err) {
    logger.warn({ err }, 'redis rate-limit store unavailable; falling back to memory');
    return undefined;
  }
}

/** Global limiter applied to the whole API. */
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:global:'),
  message: { error: 'rate_limited', message: 'Too many requests' },
});

/** Tighter limiter for auth/login to blunt credential stuffing. */
export const authRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: Math.max(5, Math.floor(config.rateLimit.max / 12)),
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:auth:'),
  message: { error: 'rate_limited', message: 'Too many login attempts' },
});

/**
 * Signup / verification / password-reset limiter — per IP, per HOUR.
 *
 * Much tighter than the others because these routes send email to an
 * attacker-chosen address: unthrottled they are a spam relay and a way to
 * enumerate accounts by timing. An hour window (rather than the global minute
 * one) is what makes a handful of attempts a meaningful ceiling.
 */
export const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: config.rateLimit.signupMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:signup:'),
  message: {
    error: 'rate_limited',
    message: 'Too many attempts from this address. Try again in an hour.',
  },
});

/**
 * PUBLIC checkout — read paths (resolve a link, poll a payment status).
 *
 * Generous on purpose: the checkout page polls the status endpoint every few
 * seconds while a customer waits for confirmations, and several customers can
 * legitimately sit behind one NAT. Too tight here breaks a paying customer's
 * page mid-payment, which is far worse than the abuse it would prevent.
 */
export const checkoutReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:checkout:read:'),
  message: { error: 'rate_limited', message: 'Too many requests. Please wait a moment.' },
});

/**
 * PUBLIC checkout — write path (starting a payment).
 *
 * Much tighter: each call derives an HD address and writes rows, so unthrottled
 * it is a cheap way to burn the derivation counter and fill the payments table
 * from the open internet. A real customer starts one payment, occasionally two.
 */
export const checkoutWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:checkout:write:'),
  message: {
    error: 'rate_limited',
    message: 'Too many payment attempts. Please wait a minute and try again.',
  },
});

/**
 * Sending an invoice by email — per MERCHANT, per hour.
 *
 * This is the only route in the system that sends mail to an address the caller
 * chooses, with content the caller writes. Unbounded, that is a spam relay
 * wearing this gateway's domain and reputation, and the first anyone would know
 * is when delivery starts failing for real merchants too.
 *
 * Keyed on the client id rather than the IP: a merchant's own server is one
 * address, and several merchants can sit behind one. The ceiling is generous
 * enough for a real billing run (a hundred invoices an hour) and far below what
 * a relay would need.
 */
export const invoiceSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:invoice:send:'),
  keyGenerator: (req) => req.client?.clientId ?? `ip:${req.ip}`,
  message: {
    error: 'rate_limited',
    message:
      'Too many invoices sent in the last hour. They are still saved — wait and send the rest.',
  },
});

/**
 * Per-API-key limiter for the merchant REST API.
 *
 * Keyed on the authenticated key id, NOT the IP — server-to-server traffic all
 * arrives from a handful of addresses, so an IP limit either throttles a busy
 * merchant or lets a leaked key run unbounded. Must be mounted AFTER
 * `merchantAuth` so `req.client.apiKeyId` is populated; requests without one
 * (dashboard JWT sessions) fall through to the global limiter untouched.
 */
export const apiKeyRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.apiKeyMax,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:key:'),
  keyGenerator: (req) => req.client?.apiKeyId ?? `ip:${req.ip}`,
  skip: (req) => !req.client?.apiKeyId,
  message: {
    error: 'rate_limited',
    message: 'Too many requests for this API key',
  },
});
