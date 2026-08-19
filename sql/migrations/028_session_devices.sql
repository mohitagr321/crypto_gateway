-- =============================================================================
-- SESSIONS THE MERCHANT CAN SEE AND REVOKE.
--
-- `refresh_tokens` already models a session correctly — one FAMILY per login,
-- rotating one row at a time — but it recorded nothing a person could
-- recognise. "You have four active sessions" is not an answer anybody can act
-- on; "Chrome on macOS, from 203.0.113.9, last used 3 minutes ago" is.
--
-- THE COLUMNS DESCRIBE THE FAMILY, NOT THE ROW. A family is one device that
-- logged in once and has been rotating its token every fifteen minutes since,
-- so the device that opened it never changes. Rotation therefore COPIES these
-- forward from the consumed row to its replacement (see storeRefreshToken), and
-- the newest row in a family carries the same device it started with.
--
-- `last_used_at` is the exception: it is the one value that legitimately moves,
-- and it is what makes the list useful. A session that last rotated three days
-- ago is a browser somebody closed; one that rotated ninety seconds ago is
-- open right now on someone's screen. That difference is the whole reason to
-- show the list.
--
-- WHY NOT A SEPARATE `sessions` TABLE. It would need to be created, joined and
-- kept in step with the family lifecycle that refresh_tokens already models
-- exactly — including reuse detection revoking a whole family, which is the one
-- operation that must never disagree between the two. Columns on the table that
-- already owns the concept cannot drift from it.
-- =============================================================================

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS device_label text,
  ADD COLUMN IF NOT EXISTS device_kind  text,
  ADD COLUMN IF NOT EXISTS ip           text,
  ADD COLUMN IF NOT EXISTS user_agent   text,
  -- Defaults to the row's own issue time so a session created before this
  -- migration reads as "last used when it was issued" rather than as never
  -- used. Backfilled below for rows that already existed.
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

UPDATE refresh_tokens
   SET last_used_at = COALESCE(last_used_at, used_at, issued_at)
 WHERE last_used_at IS NULL;

-- The session list is "the newest live row per family, for this user". Without
-- this the query degrades to a scan of every token the user has ever held,
-- which for a merchant who has been signed in for a year is thousands of rows.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_live_family
  ON refresh_tokens (user_id, family_id, issued_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON COLUMN refresh_tokens.device_label IS
  'Human-readable device for the session list, e.g. "Chrome 141 on macOS". Copied forward on every rotation — it describes the family, not the row.';
COMMENT ON COLUMN refresh_tokens.last_used_at IS
  'When this family last rotated. The only per-family value that moves, and what tells an open browser from a closed one.';
