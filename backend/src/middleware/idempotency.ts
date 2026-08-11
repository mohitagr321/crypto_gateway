/**
 * Idempotency for POST /payments.
 *
 * Keyed on the `Idempotency-Key` header, scoped per client. The first request
 * RESERVES the key, runs, and caches its response (status + body) in Redis for
 * 24h. Replays with the same key return that cached response verbatim, so a
 * merchant retry never creates a second payment / deposit address.
 *
 * ========================= WHY RESERVE BEFORE next() =========================
 * This used to be a bare `GET`, then `next()`, with the cache written from the
 * wrapped `res.json` — i.e. only once the handler had already committed. Two
 * defects came out of that, and the fix for both is to claim the key up front:
 *
 *   1. NO IN-FLIGHT MARKER. Two concurrent requests with the same key both
 *      missed the GET and both ran the handler. The unique index on
 *      (client_id, order_id) stopped the second from creating a duplicate
 *      payment, so the damage was a spurious 409 on a request that had in fact
 *      succeeded — but the guard doing the work was a database constraint, not
 *      this middleware, and it only exists because the payload happens to carry
 *      an order id.
 *
 *   2. NOTHING FINGERPRINTED THE BODY. The replay returned the cached body for
 *      WHATEVER the second request asked for. Reusing one key across two
 *      different orders — the classic integration bug — returned order A's
 *      payment id and deposit address in response to order B, so the merchant
 *      showed a customer an address whose funds credit someone else's invoice.
 *      That is a misattribution path, and it was silent. It is now a 422.
 *
 * The reservation is short-lived (RESERVATION_TTL_SECONDS) and the completed
 * record is not: a request that dies without finishing — a crash, a dropped
 * connection — leaves a marker that evaporates in a minute and lets a genuine
 * retry through, rather than a 24-hour tombstone that would strand the merchant
 * with a key they can never use and no payment to show for it. A non-2xx
 * outcome deletes the reservation on `finish` for the same reason.
 *
 * FAILS OPEN on any Redis error, deliberately and as before: this sits in front
 * of payment creation, and turning a cache blip into "no merchant can take
 * money" is far worse than briefly losing replay protection.
 */
import { NextFunction, Request, Response } from 'express';
import { redis } from '../db/redis';
import { logger } from '../config/logger';
import { sha256Hex } from '../utils/crypto';
import { AppError } from '../utils/apiError';

const TTL_SECONDS = 24 * 60 * 60; // 24h, for a COMPLETED response
const RESERVATION_TTL_SECONDS = 60; // in-flight marker only

interface CachedResponse {
  status: number;
  body: unknown;
  /** Absent on records written before this change; treated as "unknown". */
  bodyHash?: string;
}

interface Reservation {
  state: 'in_flight';
  bodyHash: string;
}

type StoredRecord = CachedResponse | Reservation;

function isComplete(record: StoredRecord): record is CachedResponse {
  return typeof (record as CachedResponse).status === 'number';
}

/**
 * What "the same request" means. Method and path are included alongside the
 * body so one key cannot be replayed against a different endpoint should this
 * middleware ever be mounted on more than one route.
 *
 * `req.rawBody` is captured by the express.json verify hook in index.ts. When
 * it is absent (a body-less or non-JSON request) every such request hashes
 * identically, which is exactly the old behaviour — no worse, and the merchant
 * API is JSON-only anyway.
 */
function fingerprint(req: Request): string {
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  return sha256Hex(`${req.method.toUpperCase()}\n${req.originalUrl}\n${rawBody}`);
}

export async function idempotency(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const key = req.header('Idempotency-Key');
  if (!key) {
    next();
    return;
  }

  const clientId = req.client?.clientId ?? 'anon';
  const redisKey = `idem:${clientId}:${key}`;
  const bodyHash = fingerprint(req);

  let claimed: string | null;
  try {
    const reservation: Reservation = { state: 'in_flight', bodyHash };
    claimed = await redis.set(
      redisKey,
      JSON.stringify(reservation),
      'EX',
      RESERVATION_TTL_SECONDS,
      'NX',
    );
  } catch (err) {
    // Cache failure must not block the request; proceed without idempotency.
    logger.warn({ err }, 'idempotency reservation failed');
    next();
    return;
  }

  if (claimed !== 'OK') {
    try {
      await serveExisting(redisKey, bodyHash, res);
    } catch (err) {
      if (err instanceof AppError) {
        next(err);
        return;
      }
      logger.warn({ err }, 'idempotency cache read failed');
      next();
      return;
    }
    return;
  }

  // We own the key. Overwrite the reservation with the real response on
  // success, and drop it on anything else so a retry can still get through.
  let cached = false;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      cached = true;
      const payload: CachedResponse = { status: res.statusCode, body, bodyHash };
      // Plain SET, not NX: the reservation we just wrote is ours to replace.
      redis
        .set(redisKey, JSON.stringify(payload), 'EX', TTL_SECONDS)
        .catch((err) => logger.warn({ err }, 'idempotency cache write failed'));
    }
    return originalJson(body);
  }) as Response['json'];

  res.on('finish', () => {
    if (cached) return;
    // 4xx/5xx, or a response that never went through res.json. Releasing the
    // key is what makes a failed create retryable with the SAME key, which is
    // precisely what a merchant's retry loop does.
    redis
      .del(redisKey)
      .catch((err) => logger.warn({ err }, 'idempotency reservation release failed'));
  });

  next();
}

/**
 * The key was already claimed. Three outcomes, and the distinction between them
 * is the point of storing the fingerprint.
 */
async function serveExisting(
  redisKey: string,
  bodyHash: string,
  res: Response,
): Promise<void> {
  const existing = await redis.get(redisKey);
  if (!existing) {
    // Raced with the reservation expiring or being released. Treat it as
    // uncontended rather than inventing a conflict.
    throw new Error('idempotency record vanished between SET and GET');
  }

  let record: StoredRecord;
  try {
    record = JSON.parse(existing) as StoredRecord;
  } catch (err) {
    throw new Error(`unparseable idempotency record: ${String(err)}`);
  }

  // Same key, different request. Returning the first response here is the
  // misattribution bug described at the top of this file, so refuse instead.
  if (record.bodyHash && record.bodyHash !== bodyHash) {
    throw new AppError(
      422,
      'idempotency_key_reuse',
      'This Idempotency-Key was already used for a different request. Use a ' +
        'fresh key per payment, and reuse a key only to retry the exact same ' +
        'request.',
    );
  }

  if (isComplete(record)) {
    res.setHeader('Idempotent-Replay', 'true');
    res.status(record.status).json(record.body);
    return;
  }

  res.setHeader('Retry-After', '1');
  throw AppError.conflict(
    'A request with this Idempotency-Key is still being processed. Retry in a ' +
      'moment; the original response will be replayed.',
  );
}
