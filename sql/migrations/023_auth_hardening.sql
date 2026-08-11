-- =============================================================================
-- 023 — Auth hardening: signed-request v2 opt-in, and revocable refresh tokens
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/023_auth_hardening.sql
-- Rollback:  sql/migrations/023_auth_hardening_rollback.sql
--
-- Two independent security fixes share one migration because both are additive,
-- both are read by backend/src/middleware/auth.ts + backend/src/routes/auth.ts,
-- and neither is useful without the other half of the same deploy.
--
-- ============================ 1. api_keys.signature_version ==================
-- WHAT WAS WRONG
--   The merchant HMAC covered `${timestamp}.${rawBody}` and nothing else. It
--   bound neither the HTTP METHOD nor the PATH, so every body-less request at a
--   given second signs BYTE-IDENTICAL bytes. A signature captured from a
--   routine `GET /api/v1/payments` poll is therefore a valid signature for
--   `POST /invoices/{id}/void`, `POST /payment-links/{id}/disable`,
--   `POST /subscriptions/{id}/cancel` and `POST /payouts` — for the whole
--   5-minute skew window. The timestamp check bounded the window; nothing
--   bounded the endpoint.
--
-- WHAT THIS ADDS
--   api_keys.signature_version
--     1 (default, and what EVERY existing key gets) — the server accepts the
--       new v2 signed string OR the legacy v1 one. This is the deprecation
--       window: merchants can upgrade their SDK whenever they like and nothing
--       breaks in either order.
--     2 — v2 only. Flipping a key to 2 is what actually closes the hole for
--       that merchant, and is a BREAKING change for any integration still
--       signing v1, so flip it per key after confirming the upgrade.
--
--   v2 signed string:
--       `${timestamp}.${METHOD}.${originalUrl}.${sha256_hex(rawBody)}`
--     originalUrl is the path exactly as sent, INCLUDING the /api/v1 prefix and
--     the query string; rawBody is the empty string for a body-less request.
--
--   *** docs/sdk/javascript.md, docs/sdk/php.md, docs/sdk/python.md and
--   *** docs/openapi.yaml are the normative definition of this scheme for every
--   *** merchant. They MUST be updated in the same release as this migration.
--
--   Operator query once an integration is upgraded:
--       UPDATE api_keys SET signature_version = 2 WHERE api_key = 'pk_live_…';
--   And to walk back a premature flip:
--       UPDATE api_keys SET signature_version = 1 WHERE api_key = 'pk_live_…';
--
-- ============================ 2. refresh_tokens ==============================
-- WHAT WAS WRONG
--   POST /auth/refresh rebuilt its claims FROM THE PRESENTED TOKEN and never
--   touched the database. Suspending a user did nothing (status is only checked
--   at /login), demoting one did nothing (role came out of the token), and a
--   stolen refresh token was a permanent credential that re-minted a fresh
--   7-day token on every use. There was no server-side record of an issued
--   refresh token, so there was nothing to revoke.
--
-- WHAT THIS ADDS
--   One row per issued refresh token, holding only its SHA-256 (the token
--   itself is never stored — same reasoning as user_tokens.token_hash). The
--   route consumes a row atomically on rotation; presenting an already-consumed
--   token revokes the whole `family_id`, which is standard reuse detection.
--
--   `family_id` chains a login to every rotation descended from it, so one
--   UPDATE revokes a whole session lineage.
--
-- ============================ SAFETY / BACK-COMPAT ===========================
--   Purely additive and idempotent; no existing row is rewritten and no code
--   path stops working.
--
--   ORDERING. Apply this BEFORE deploying the matching backend. If the code
--   lands first it degrades on purpose rather than failing: middleware/auth.ts
--   catches undefined_column and treats every key as version 1, and
--   routes/auth.ts catches undefined_table and issues untracked refresh tokens.
--   Both log at ERROR and both need an API restart after this migration runs.
--
--   SESSIONS SURVIVE. Refresh tokens minted before the deploy have no row here.
--   routes/auth.ts accepts such a token once and adopts it into a tracked
--   family, so nobody is signed out at deploy time. Once 7 days
--   (JWT_REFRESH_EXPIRES_IN) have passed, every live token is tracked — set
--   ALLOW_UNTRACKED_REFRESH_TOKENS=false then to make reuse detection airtight.
--
--   HOUSEKEEPING. routes/auth.ts deletes a user's own expired rows whenever it
--   writes a new one, so an active account cannot accumulate. Rows belonging to
--   users who never return are left to an operator sweep:
--       DELETE FROM refresh_tokens WHERE expires_at < now() - interval '30 days';
-- =============================================================================

BEGIN;

-- ---------- 1. signed-request version, per API key ---------------------------

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS signature_version SMALLINT NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_signature_version_check'
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_signature_version_check
      CHECK (signature_version IN (1, 2));
  END IF;
END $$;

COMMENT ON COLUMN api_keys.signature_version IS
  'Merchant request signing scheme this key is held to. '
  '1 = accept v2 (timestamp.METHOD.path.sha256(body)) OR legacy v1 '
  '(timestamp.body) — the deprecation window. '
  '2 = v2 only; legacy v1 signatures are rejected. '
  'v1 bound neither method nor path, so a captured signature was replayable '
  'against any other body-less endpoint inside the 5-minute skew window.';

-- ---------- 2. revocable refresh tokens --------------------------------------

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- One login and every rotation descended from it. Revoking a family is how
  -- reuse detection signs out the thief and the victim together.
  family_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  -- sha256(refresh JWT). The token is never stored: the server only ever needs
  -- to RECOGNISE it, exactly like user_tokens.token_hash.
  token_hash  TEXT NOT NULL UNIQUE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Mirrors the JWT's own exp, so JWT_REFRESH_EXPIRES_IN stays the one source
  -- of truth for how long a session lives.
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,   -- set when rotated; a second use is reuse
  revoked_at  TIMESTAMPTZ    -- set for the whole family on reuse / suspension
);

-- Family revocation must be one cheap UPDATE, not a scan.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);
-- Per-user pruning on rotation, and "sign this user out everywhere" by hand.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id);
-- The operator sweep for users who never come back.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);

COMMENT ON TABLE refresh_tokens IS
  'Issued dashboard refresh tokens (hash only), so a session can actually be '
  'revoked. Rotation: presenting a token consumes it and issues a replacement '
  'in the same family_id; presenting a consumed one revokes the family.';

COMMIT;
