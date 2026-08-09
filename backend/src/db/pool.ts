/**
 * PostgreSQL connection pool.
 *
 * - `query<T>()` runs a single parameterized statement.
 * - `withTransaction()` runs a callback inside BEGIN/COMMIT, rolling back on throw.
 *
 * ONLY parameterized queries are used anywhere in the codebase (no string
 * interpolation of user input) to avoid SQL injection.
 */
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { config } from '../config/env';
import { logger } from '../config/logger';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres pool error');
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

export async function closePool(): Promise<void> {
  await pool.end();
}
