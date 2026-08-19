-- Rollback for 028_session_devices.sql.
--
-- Dropping these columns disables the session list but leaves authentication
-- intact: rotation and reuse detection never read them, so a panel running the
-- new code against a rolled-back schema loses /account/sessions and nothing
-- else. Roll the API back too, or those three routes will 500.
DROP INDEX IF EXISTS idx_refresh_tokens_live_family;

ALTER TABLE refresh_tokens
  DROP COLUMN IF EXISTS device_label,
  DROP COLUMN IF EXISTS device_kind,
  DROP COLUMN IF EXISTS ip,
  DROP COLUMN IF EXISTS user_agent,
  DROP COLUMN IF EXISTS last_used_at;
