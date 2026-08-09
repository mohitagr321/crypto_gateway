/**
 * Idempotency for POST /payments.
 *
 * Keyed on the `Idempotency-Key` header (scoped per client). The first request
 * runs normally and its response (status + body) is cached in Redis for 24h.
 * Replays with the same key return the cached response verbatim, so a merchant
 * retry never creates a second payment / deposit address.
 *
 * We wrap res.json to capture the outgoing body only on a successful (2xx) create.
 */
import { NextFunction, Request, Response } from 'express';
import { redis } from '../db/redis';
import { logger } from '../config/logger';

const TTL_SECONDS = 24 * 60 * 60; // 24h

interface CachedResponse {
  status: number;
  body: unknown;
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

  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedResponse;
      res.setHeader('Idempotent-Replay', 'true');
      res.status(parsed.status).json(parsed.body);
      return;
    }
  } catch (err) {
    // Cache read failure should not block the request; proceed without idempotency.
    logger.warn({ err }, 'idempotency cache read failed');
    next();
    return;
  }

  // Intercept res.json to persist the response on success.
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const payload: CachedResponse = { status: res.statusCode, body };
      redis
        .set(redisKey, JSON.stringify(payload), 'EX', TTL_SECONDS, 'NX')
        .catch((err) => logger.warn({ err }, 'idempotency cache write failed'));
    }
    return originalJson(body);
  }) as Response['json'];

  next();
}
