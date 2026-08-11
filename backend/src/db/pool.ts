/**
 * PostgreSQL connection pool.
 *
 * - `query<T>()` runs a single parameterized statement.
 * - `withTransaction()` runs a callback inside BEGIN/COMMIT, rolling back on throw.
 *
 * ONLY parameterized queries are used anywhere in the codebase (no string
 * interpolation of user input) to avoid SQL injection.
 *
 * ============================ SIZING THE POOL ================================
 * `max` is PER PROCESS, and this file is imported by every process type: the
 * api, the workers, and one listener per chain. The fleet arithmetic is
 *
 *     connections = max x (api replicas + worker replicas + listener count)
 *
 * so the old hard-coded `max: 20` meant `--scale api=4` plus 3 workers plus 4
 * listeners asked Postgres for up to 220 connections against a stock
 * `max_connections = 100`. The number is therefore read from DB_POOL_MAX and
 * has to be set per role at deploy time (or, better, PgBouncer in transaction
 * pooling mode is put in front so pool size and max_connections are decoupled).
 * The default stays 20 so a single-instance deployment behaves exactly as it
 * did before this change.
 *
 * ============================ WHY THE TIMEOUTS EXIST ==========================
 * A pool with no server-side timeouts is a pool with no upper bound on how long
 * one bad query can hold a connection. One unindexed aggregate on an admin
 * dashboard could pin all 20 connections, at which point EVERY request —
 * including authentication, which does a SELECT before any route body runs —
 * queued for the full acquire timeout and then failed. `/health` does no
 * database work, so the probe stayed green throughout.
 *
 *   - `statement_timeout` bounds how long a single statement may run before the
 *     SERVER aborts it and hands the connection back. This is the one that
 *     actually breaks the deadlock; without it the client gives up but the
 *     query keeps burning the connection.
 *   - `idle_in_transaction_session_timeout` bounds a transaction that opened and
 *     then stopped doing work (a crashed caller, a lost socket). Safe here
 *     because no `withTransaction` body awaits network I/O — every chain
 *     broadcast happens OUTSIDE the transaction, by design.
 *   - `connectionTimeoutMillis` is how long a caller waits for a free
 *     connection. Dropped from 10s to 2s: a request that cannot get a
 *     connection within 2s is a request whose client has already given up, and
 *     failing fast sheds load instead of accumulating it.
 *
 * Note both server-side timeouts are startup parameters on the connection, so
 * they apply to every statement on it without any caller having to opt in.
 */
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config/env';
import { logger } from '../config/logger';

/**
 * Read a positive-integer tunable from the environment. An unset, empty or
 * unparseable value falls back rather than throwing: a typo in a deploy
 * variable must not stop the process from booting and connecting.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    logger.warn({ name, value: raw, fallback }, 'invalid integer env var; using default');
    return fallback;
  }
  return n;
}

/** Per-process pool size. See "SIZING THE POOL" above before raising it. */
const POOL_MAX = Math.max(1, envInt('DB_POOL_MAX', 20));

/**
 * Server-side statement ceiling for the money path. 0 disables it, which is
 * supported only as an escape hatch for an operator debugging a specific slow
 * query — running without it is the failure mode this whole block exists for.
 */
const STATEMENT_TIMEOUT_MS = envInt('DB_STATEMENT_TIMEOUT_MS', 15_000);

/**
 * Tighter ceiling for the reporting pool. Analytics is allowed to fail; the
 * money path is not, and a dashboard must never be the reason it cannot get a
 * connection.
 */
const READ_STATEMENT_TIMEOUT_MS = envInt('DB_READ_STATEMENT_TIMEOUT_MS', 5_000);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
  statement_timeout: STATEMENT_TIMEOUT_MS === 0 ? false : STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: 30_000,
  application_name: 'paycrypo',
});

/**
 * A SEPARATE, SMALL pool for read-only reporting — admin analytics, wallet
 * overviews, exports.
 *
 * The point is bulkhead isolation, not speed: queries here draw from their own
 * small allowance of connections, so an operator refreshing a dashboard during
 * a traffic burst can exhaust THIS pool and leave the payment path untouched.
 * It carries a tighter statement_timeout for the same reason.
 *
 * Connections are opened lazily by pg, so this costs nothing until something
 * actually calls `readQuery`. Use it only for statements that are read-only and
 * whose failure is survivable; anything that writes, or that a payment/payout
 * depends on, belongs on `pool`.
 */
export const readPool = new Pool({
  connectionString: config.databaseUrl,
  max: Math.max(1, envInt('DB_READ_POOL_MAX', 5)),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
  statement_timeout: READ_STATEMENT_TIMEOUT_MS === 0 ? false : READ_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: 30_000,
  application_name: 'paycrypo-read',
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres pool error');
});

readPool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres read-pool error');
});

/**
 * Run a parameterized query and return the typed rows.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params as unknown[]);
  return res.rows;
}

/**
 * Run a parameterized query and return the first row or null.
 */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run a READ-ONLY reporting query on the isolated read pool. See `readPool`.
 * Never use this for a statement that writes, or that a payment or payout waits
 * on — it has a shorter statement_timeout and a much smaller connection budget.
 */
export async function readQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T[]> {
  const res = await readPool.query<T>(text, params as unknown[]);
  return res.rows;
}

/** `readQuery`, returning the first row or null. */
export async function readQueryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const rows = await readQuery<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Execute `fn` inside a transaction. The provided client MUST be used for all
 * statements that should participate in the transaction.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * True when `err` is pg giving up waiting for a free connection, as opposed to
 * a query that actually failed. The distinction matters to the caller: this one
 * is a saturation signal and the right answer is 503 + Retry-After, not 500.
 */
export function isPoolExhaustedError(err: unknown): boolean {
  return err instanceof Error && /timeout exceeded when trying to connect/i.test(err.message);
}

export async function closePool(): Promise<void> {
  // Both pools, and neither failure hides the other — a shutdown that leaves a
  // pool open holds server-side connections until they time out.
  const results = await Promise.allSettled([pool.end(), readPool.end()]);
  for (const r of results) {
    if (r.status === 'rejected') logger.error({ err: r.reason }, 'pool shutdown failed');
  }
}
