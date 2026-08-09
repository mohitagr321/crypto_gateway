/**
 * Single-use, expiring tokens for email verification and password reset.
 *
 * Storage rule: the raw token exists ONLY inside the emailed link. The database
 * holds `sha256(token)`. A database read therefore cannot be replayed into an
 * account takeover — the same reason `api_keys.token_hash` is a digest rather
 * than an envelope (see services/apiKeyService.ts).
 *
 * Consumption is a single UPDATE ... WHERE used_at IS NULL ... RETURNING, so two
 * concurrent clicks on the same link cannot both succeed: exactly one UPDATE
 * matches a row, the other sees zero rows and gets the invalid-token error.
 */
import { PoolClient } from 'pg';
import { query, queryOne } from '../db/pool';
import { randomToken, sha256Hex } from '../utils/crypto';

export type TokenPurpose = 'email_verify' | 'password_reset';

/**
 * Mint a token for `userId`, invalidating any outstanding token for the same
 * purpose. Returns the RAW token — the only time it exists — for the caller to
 * put in an email. Never log it.
 */
export async function issueToken(
  userId: string,
  purpose: TokenPurpose,
  ttlMs: number,
  tx?: PoolClient,
): Promise<string> {
  const raw = randomToken(32);
  const hash = sha256Hex(raw);
  const expiresAt = new Date(Date.now() + ttlMs);

  // Supersede outstanding tokens: a merchant who clicks "resend" expects the
  // older link to stop working, and it keeps at most one live token per purpose.
  const invalidate = `UPDATE user_tokens SET used_at = now()
                       WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`;
  const insert = `INSERT INTO user_tokens (user_id, purpose, token_hash, expires_at)
                  VALUES ($1, $2, $3, $4)`;

  if (tx) {
    await tx.query(invalidate, [userId, purpose]);
    await tx.query(insert, [userId, purpose, hash, expiresAt]);
  } else {
    await query(invalidate, [userId, purpose]);
    await query(insert, [userId, purpose, hash, expiresAt]);
  }
  return raw;
}

/**
 * Atomically consume a token. Returns the owning user id, or null when the token
 * is unknown, already used, expired, or issued for a different purpose — all
 * four collapse to the same null so the caller cannot leak which it was.
 */
export async function consumeToken(
  rawToken: string,
  purpose: TokenPurpose,
  tx?: PoolClient,
): Promise<string | null> {
  const hash = sha256Hex(rawToken);
  const sql = `UPDATE user_tokens
                  SET used_at = now()
                WHERE token_hash = $1
                  AND purpose    = $2
                  AND used_at IS NULL
                  AND expires_at > now()
                RETURNING user_id`;
  const row = tx
    ? (await tx.query<{ user_id: string }>(sql, [hash, purpose])).rows[0]
    : await queryOne<{ user_id: string }>(sql, [hash, purpose]);
  return row?.user_id ?? null;
}

/**
 * Delete tokens that expired more than a day ago. Nothing depends on this — it
 * is hygiene, and the table is tiny — so it is safe to call opportunistically.
 */
export async function purgeExpiredTokens(): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM user_tokens
      WHERE expires_at < now() - INTERVAL '1 day'
      RETURNING id`,
  );
  return rows.length;
}
