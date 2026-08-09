/**
 * Redis clients.
 *
 * - `redis` is a shared general-purpose client (caching, idempotency, rate limits).
 * - `createBullConnection()` returns a fresh connection configured for BullMQ.
 *   BullMQ requires `maxRetriesPerRequest: null` and does NOT share the app client,
 *   so every Queue / Worker / QueueEvents instance gets its own connection.
 */
import IORedis, { RedisOptions } from 'ioredis';
import { config } from '../config/env';
import { logger } from '../config/logger';

export const redis = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  logger.error({ err }, 'redis client error');
});

/**
 * BullMQ-compatible connection factory.
 * BullMQ blocking commands require maxRetriesPerRequest = null.
 */
export function createBullConnection(): IORedis {
  const conn = new IORedis(config.redisUrl, bullConnectionOptions);
  conn.on('error', (err) => {
    logger.error({ err }, 'bullmq redis connection error');
  });
  return conn;
}

/**
 * Connection options for BullMQ Queue/Worker `connection`. Passing options (rather
 * than a pre-built ioredis instance) lets BullMQ own the connection and avoids
 * type friction between the app's ioredis and BullMQ's bundled ioredis.
 */
export const bullConnectionOptions: RedisOptions & { url?: string } = (() => {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
})();

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
