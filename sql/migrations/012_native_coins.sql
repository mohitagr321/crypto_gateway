-- =============================================================================
-- 012 — Native coins (BNB, TRX) as payable assets
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/012_native_coins.sql
-- Rollback:  sql/migrations/012_native_coins_rollback.sql
--
-- WHAT THIS ENABLES
--   Accepting the chains' OWN currency as payment, not just tokens on them.
--
-- WHY THERE IS ALMOST NOTHING HERE
--   The ledger already models this. An asset is `(network, symbol)`, and
--   `payments.asset` / `blockchain_transactions.asset` are plain text — so BNB
--   on BEP20 and TRX on TRC20 are just two more rows in a design that already
--   refuses to sum across assets. No column, constraint or index changes.
--
--   The `assets` table carries only enable/display state (contract addresses and
--   decimals live in backend/src/blockchain/assets.ts, deliberately), so seeding
--   two rows is the whole schema story.
--
-- ============================ ENABLED IS NOT THE SAME AS ACCEPTED ============
--   These rows are seeded `enabled = false`. Turning them on takes BOTH
--   `ACCEPT_NATIVE_COINS=true` and the symbol in the network's allowlist
--   (`ASSETS_BEP20=...,BNB`). That is deliberate: a native coin's sweep pays its
--   fee OUT OF the balance being moved, the inverse of the token flow, and
--   getting the reserve wrong strands funds at a deposit address rather than
--   failing loudly. A row in this table must never be the thing that switches
--   that on.
--
-- ============================ NOTE ON log_index ==============================
--   Native transfers have no log — there is no contract, so nothing is emitted.
--   The listeners record them with `log_index = -1`, which cannot collide with a
--   real log index (those are non-negative) under the existing
--   UNIQUE (tx_hash, log_index). No schema change is needed for that either; it
--   is recorded here so the convention is findable.
--
-- SAFETY
--   Additive and inert. On a deployment that never sets ACCEPT_NATIVE_COINS,
--   nothing observable changes.
-- =============================================================================

BEGIN;

INSERT INTO assets (network, symbol, display_name, enabled, sort_order) VALUES
  ('BEP20', 'BNB', 'BNB',  false, 90),
  ('TRC20', 'TRX', 'TRON', false, 90)
ON CONFLICT (network, symbol) DO NOTHING;

COMMENT ON TABLE assets IS
  'Enable/display state for assets, including the native coins BNB and TRX. '
  'Contract addresses and decimals live in backend/src/blockchain/assets.ts and '
  'are NOT configurable here — a wrong value in either is a fund-loss bug. '
  'Native coins additionally require ACCEPT_NATIVE_COINS=true; a row here is '
  'never sufficient to start accepting one.';

COMMIT;
