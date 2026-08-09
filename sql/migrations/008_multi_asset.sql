-- =============================================================================
-- 008 — Multi-asset ledger: accept more than one token per network
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/008_multi_asset.sql
-- Rollback:  sql/migrations/008_multi_asset_rollback.sql
--
-- WHAT THIS ENABLES
--   Until now the gateway settled exactly one token — USDT — and `currency`
--   existed but never varied. Balances aggregate per (client, network) with the
--   symbol hardcoded, so there was literally nowhere to put a USDC balance.
--
--   An ASSET is the pair (network, symbol). USDT-BEP20 and USDT-TRC20 are
--   different assets with different contracts and different decimals (18 vs 6).
--   Funds are not fungible across assets any more than across chains, so nothing
--   may ever sum across them.
--
-- SAFETY / BACK-COMPAT
--   Additive and idempotent. The backfill is free: `asset` defaults to 'USDT'
--   and every row that exists today IS USDT, so existing payments, payouts and
--   balances keep their exact current meaning. An integration that never sends
--   `asset` continues to get USDT.
--
--   Contract addresses and decimals are deliberately NOT stored here — they live
--   in backend/src/blockchain/assets.ts. A wrong contract address credits
--   payments against a token nobody sent, and wrong decimals mis-scale every
--   amount by orders of magnitude. Neither belongs behind an admin toggle. The
--   `assets` table below carries only enable/display state.
-- =============================================================================

BEGIN;

-- ---------- asset column on every money-carrying table ----------------------
ALTER TABLE payments                 ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'USDT';
ALTER TABLE payouts                  ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'USDT';
ALTER TABLE blockchain_transactions  ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'USDT';
ALTER TABLE admin_withdrawals        ADD COLUMN IF NOT EXISTS asset TEXT NOT NULL DEFAULT 'USDT';

COMMENT ON COLUMN payments.asset IS
  'Token symbol, scoped to this row''s network: (network, asset) identifies one '
  'entry in blockchain/assets.ts. Fixed at creation and never changed.';
COMMENT ON COLUMN payouts.asset IS
  'Asset settled. Balances are per (client, network, asset) — a USDC payout can '
  'never draw on a USDT balance.';

-- `payments.currency` predates this and duplicated the same idea. Keep it in
-- sync rather than dropping it: it is in the public API response shape and in
-- the OpenAPI contract, so removing it would be a breaking change for merchants.
UPDATE payments SET currency = asset WHERE currency IS DISTINCT FROM asset;

-- ---------- indexes backing the per-asset balance guard ---------------------
-- getBalanceWith runs INSIDE the payout advisory lock; these keep that read
-- cheap now that it also filters on asset. The pre-existing
-- (client_id, network, status) indexes from 005 stay — they still serve the
-- network-wide aggregate used by reporting.
CREATE INDEX IF NOT EXISTS idx_payments_client_network_asset_status
  ON payments(client_id, network, asset, status);
CREATE INDEX IF NOT EXISTS idx_payouts_client_network_asset_status
  ON payouts(client_id, network, asset, status);
CREATE INDEX IF NOT EXISTS idx_btx_network_asset
  ON blockchain_transactions(network, asset);

-- ---------- merchant settlement preference ----------------------------------
-- Which asset a merchant wants to be paid in. Consumed by the wrong-payment
-- auto-conversion work (a later release); recorded now so the column exists
-- before anything depends on it. NULL = no preference, settle in kind.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS preferred_payout_asset TEXT;

COMMENT ON COLUMN clients.preferred_payout_asset IS
  'Asset this merchant prefers to receive. NULL = settle each payment in the '
  'asset it arrived as. Drives conversion of unexpected deposits.';

-- ---------- assets table (enable/display state ONLY) ------------------------
-- Mirrors the code registry so an operator can switch an asset off without a
-- deploy. It intentionally does NOT carry contract or decimals: the code is
-- authoritative for anything whose wrongness loses money.
CREATE TABLE IF NOT EXISTS assets (
  network     TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  display_name TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  sort_order  INT NOT NULL DEFAULT 100,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, symbol)
);

COMMENT ON TABLE assets IS
  'Enable/display state for assets. Contract addresses and decimals live in '
  'backend/src/blockchain/assets.ts and are NOT configurable here — a wrong '
  'value in either is a fund-loss bug.';

-- Seed what the code registry knows. ON CONFLICT DO NOTHING so a re-run never
-- re-enables an asset an operator has deliberately switched off.
INSERT INTO assets (network, symbol, display_name, sort_order) VALUES
  ('BEP20', 'USDT', 'Tether USD',         10),
  ('BEP20', 'USDC', 'USD Coin',           20),
  ('BEP20', 'BUSD', 'Binance USD',        30),
  ('BEP20', 'DAI',  'Dai Stablecoin',     40),
  ('TRC20', 'USDT', 'Tether USD',         10),
  ('TRC20', 'USDC', 'USD Coin',           20),
  ('TRC20', 'USDD', 'Decentralized USD',  30)
ON CONFLICT (network, symbol) DO NOTHING;

-- ---------- updated_at trigger for the new table ----------------------------
DO $$
BEGIN
  CREATE TRIGGER trg_assets_updated BEFORE UPDATE ON assets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
