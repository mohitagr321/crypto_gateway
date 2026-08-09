-- =============================================================================
-- 007 ROLLBACK — remove self-registration, email verification and simple keys.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/007_self_registration_rollback.sql
--
-- Use this ONLY if you are also reverting the application code to a build
-- without self-registration. The added columns are inert to the old code (it
-- selects none of them), so rolling the code back alone is already safe — this
-- teardown exists to return the schema to its exact pre-007 shape.
--
-- !! DESTRUCTIVE !!
--   Refuses to run while any `simple` API key exists. Dropping auth_mode would
--   silently reinterpret those rows as HMAC keys whose api_secret_hash is NULL,
--   which fails closed at auth time (every request 500s on decrypt) — i.e. it
--   would take live merchant integrations offline without warning. Revoke or
--   replace simple keys first.
--
--   Self-registered clients are NOT deleted; they simply lose the marker that
--   says how they arrived. Nothing about their money path depends on it.
-- =============================================================================

BEGIN;

DO $$
DECLARE simple_count INT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'api_keys' AND column_name = 'auth_mode'
  ) THEN
    SELECT COUNT(*) INTO simple_count
      FROM api_keys WHERE auth_mode = 'simple' AND status = 'active';
    IF simple_count > 0 THEN
      RAISE EXCEPTION
        'Refusing to roll back: % active simple-mode API key(s) exist. Dropping '
        'auth_mode would leave them as HMAC keys with no secret, breaking every '
        'request those merchants make. Revoke them first.', simple_count;
    END IF;
  END IF;
END $$;

-- ---------- api_keys ---------------------------------------------------------
-- Restore NOT NULL first: it can only be re-asserted once no simple-mode rows
-- (the only rows with a NULL secret) remain. Revoked simple keys are deleted
-- here because they are unusable under the old code and would block the
-- constraint. They carry no financial history — payments reference the client,
-- not the key.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_mode_material_check;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_auth_mode_check;

DELETE FROM api_keys WHERE api_secret_hash IS NULL;

ALTER TABLE api_keys ALTER COLUMN api_secret_hash SET NOT NULL;

DROP INDEX IF EXISTS idx_api_keys_token_hash;
ALTER TABLE api_keys DROP COLUMN IF EXISTS token_hash;
ALTER TABLE api_keys DROP COLUMN IF EXISTS scopes;
ALTER TABLE api_keys DROP COLUMN IF EXISTS auth_mode;

-- ---------- clients ----------------------------------------------------------
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_signup_source_check;
DROP INDEX IF EXISTS idx_clients_signup_source;
ALTER TABLE clients DROP COLUMN IF EXISTS onboarding_completed_at;
ALTER TABLE clients DROP COLUMN IF EXISTS country;
ALTER TABLE clients DROP COLUMN IF EXISTS website_url;
ALTER TABLE clients DROP COLUMN IF EXISTS signup_source;

-- ---------- users / tokens ---------------------------------------------------
DROP TABLE IF EXISTS user_tokens;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;

-- ---------- indexes added purely for the onboarding checklist ----------------
DROP INDEX IF EXISTS idx_payments_client_created;

COMMIT;
