-- =============================================================================
-- 007 — Merchant self-registration, email verification, and multi-mode API keys
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/007_self_registration.sql
-- Rollback:  sql/migrations/007_self_registration_rollback.sql
--
-- NUMBERING NOTE
--   `main` already carries 005_payout_idempotency.sql and the unmerged
--   feat/erc20-multi-network branch carries its own 005_erc20_and_payout_wallets.
--   This migration takes 007 so that 006 stays free for the ERC20 branch to
--   renumber into when it merges. Deploy applies sql/migrations/*.sql in glob
--   order, so the numbers must never collide.
--
-- WHAT THIS ENABLES
--   1. A merchant can create their own account. Signup writes an UNVERIFIED user
--      and a `pending` client; clicking the emailed link verifies the address and
--      flips the client to `approved`. No operator involvement.
--   2. API keys become multi-key and dual-mode. The existing HMAC scheme
--      (X-Api-Key + X-Timestamp + X-Signature) is untouched and remains the
--      default. A second `simple` mode accepts a single opaque bearer token in
--      X-Api-Key, matching what most crypto gateways expose.
--
-- SAFETY / BACK-COMPAT
--   Additive and idempotent. Two backfills are load-bearing:
--     * users.email_verified is set TRUE for every pre-existing row. Admin- and
--       operator-created accounts were never emailed a link, so defaulting them
--       to FALSE would lock every current user — including super_admin — out.
--     * api_keys.scopes is set to the full scope set for every pre-existing row,
--       preserving exactly the access those keys have today.
--   api_secret_hash loses its NOT NULL because a `simple` key has no HMAC secret;
--   a CHECK constraint keeps each mode's required column populated instead.
-- =============================================================================

BEGIN;

-- ---------- users: email verification ----------------------------------------
-- Added with DEFAULT true so every PRE-EXISTING row is backfilled verified in
-- the same statement, then the default is flipped to false for rows created from
-- here on. This two-step is deliberate: it backfills without an UPDATE and it is
-- exactly idempotent — a re-run finds the column present (ADD ... IF NOT EXISTS
-- is a no-op) and re-asserts the same default, so it can never re-verify an
-- account that has since been un-verified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;

COMMENT ON COLUMN users.email_verified IS
  'TRUE once the address has been proven via an emailed token. Accounts that '
  'predate migration 007 were backfilled TRUE — they were provisioned by an '
  'operator out of band and were never sent a verification link.';

-- ---------- user_tokens: email verification + password reset -----------------
-- One table serves both purposes (and invites later). Only the SHA-256 of the
-- token is stored — the raw value exists solely inside the email link, so a
-- database read cannot be replayed into an account takeover.
CREATE TABLE IF NOT EXISTS user_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('email_verify','password_reset')),
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash);
-- Issuing a fresh token invalidates the outstanding ones for that purpose; this
-- index is what keeps that sweep cheap.
CREATE INDEX IF NOT EXISTS idx_user_tokens_open
  ON user_tokens(user_id, purpose) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_tokens_expiry ON user_tokens(expires_at);

COMMENT ON TABLE user_tokens IS
  'Single-use, expiring tokens for email verification and password reset. '
  'token_hash = sha256(raw token); the raw token is never persisted.';

-- ---------- clients: signup provenance + onboarding --------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS signup_source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS website_url   TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS country       TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE clients ADD CONSTRAINT clients_signup_source_check
    CHECK (signup_source IN ('admin','self'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN clients.signup_source IS
  '''self'' = merchant registered themselves through the public panel; '
  '''admin'' = provisioned via POST /admin/clients. Pre-existing rows are admin.';
COMMENT ON COLUMN clients.onboarding_completed_at IS
  'Set once the merchant has a payout wallet, an API key and a webhook URL. '
  'Drives whether the get-started checklist is still shown.';

CREATE INDEX IF NOT EXISTS idx_clients_signup_source ON clients(signup_source);

-- ---------- api_keys: multi-key, dual auth mode, scopes ----------------------
-- auth_mode  : 'hmac'   -> X-Api-Key + X-Timestamp + X-Signature (unchanged)
--              'simple' -> the X-Api-Key value IS the secret (bearer style)
-- token_hash : sha256 of the simple-mode bearer token. The token itself is never
--              stored — unlike the HMAC secret, the server never needs to read it
--              back, so hashing is strictly better than the envelope encryption
--              api_secret_hash uses (see middleware/auth.ts for that design note).
-- scopes     : what the key may do. A leaked bearer token must not be able to
--              move money, so simple keys are issued without 'payouts:write'.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS auth_mode  TEXT NOT NULL DEFAULT 'hmac';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes     TEXT[] NOT NULL
  DEFAULT ARRAY['payments:read','payments:write','payouts:write']::TEXT[];

-- A simple key has no HMAC secret to store.
ALTER TABLE api_keys ALTER COLUMN api_secret_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_token_hash
  ON api_keys(token_hash) WHERE token_hash IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_auth_mode_check
    CHECK (auth_mode IN ('hmac','simple'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Each mode must carry its own credential material.
DO $$
BEGIN
  ALTER TABLE api_keys ADD CONSTRAINT api_keys_mode_material_check
    CHECK (
      (auth_mode = 'hmac'   AND api_secret_hash IS NOT NULL) OR
      (auth_mode = 'simple' AND token_hash      IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN api_keys.auth_mode IS
  '''hmac'' = signed requests (X-Timestamp + X-Signature). ''simple'' = the '
  'X-Api-Key header value is itself the bearer secret.';
COMMENT ON COLUMN api_keys.token_hash IS
  'sha256 of the simple-mode bearer token. NULL for hmac keys.';
COMMENT ON COLUMN api_keys.scopes IS
  'Permitted operations. Simple-mode keys are issued WITHOUT payouts:write so a '
  'leaked bearer token cannot initiate a settlement.';

-- ---------- webhook/IPN convenience ------------------------------------------
-- The onboarding checklist asks "has this merchant ever received a payment?".
-- Answering it per client without a sequential scan.
CREATE INDEX IF NOT EXISTS idx_payments_client_created
  ON payments(client_id, created_at DESC);

COMMIT;
