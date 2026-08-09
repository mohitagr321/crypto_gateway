-- =============================================================================
-- 014 — Bitcoin as a settlement network
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/014_bitcoin.sql
-- Rollback:  sql/migrations/014_bitcoin_rollback.sql
--
-- ============================ BITCOIN IS A DIFFERENT SHAPE ===================
--   Every chain before this one has ACCOUNTS: an address has a balance, and a
--   transfer debits one and credits another. Bitcoin has UTXOs — an address
--   "holds" a set of unspent outputs, and a transfer consumes some whole and
--   creates new ones. Three consequences show up in the schema's assumptions:
--
--   1. THERE IS NO TOKEN LAYER. BTC is the only asset on this network, and it
--      is native. It is therefore seeded ENABLED, unlike BNB/TRX/ETH which sit
--      behind ACCEPT_NATIVE_COINS — that flag exists because accepting a chain's
--      GAS currency as payment inverts the sweep's fee flow. On Bitcoin there is
--      no separate gas currency to invert anything against, so the flag would be
--      gating the only thing this network can do.
--
--   2. FEES ARE PRICED BY TRANSACTION SIZE, not by gas. Nothing schema-side
--      changes, but `blockchain_transactions.amount` for a sweep is
--      `total inputs − fee`, and the fee depends on how many UTXOs were
--      consumed. Two sweeps of the same value can cost different amounts.
--
--   3. THERE IS NO NONCE. Payout idempotence comes from re-broadcasting the
--      EXACT signed bytes (same txid) — `payouts.signed_tx` already carries
--      them. Re-SIGNING is unsafe here in a way it is not on an EVM chain, and
--      is refused; see services/chainBroadcast.ts.
--
-- ============================ 8 DECIMALS =====================================
--   BTC is 8 dp. The ledger's internal accounting scale is 18 dp and holds that
--   losslessly (see utils/money.ts, which anticipated exactly this). As always,
--   decimals are a property of the ASSET and live in blockchain/assets.ts.
--
-- SAFETY
--   Additive. Widening a CHECK constraint cannot invalidate an existing row.
-- =============================================================================

BEGIN;

-- ---------- payments.network: admit BTC --------------------------------------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_network_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_network_check
  CHECK (network IN ('BEP20','TRC20','ERC20','BTC'));

-- ---------- per-network payout wallet ----------------------------------------
-- A Bitcoin address shares no format with any other chain here (bc1q…/tb1q…
-- bech32, or a legacy 1…/3…), so unlike the EVM pair there is no risk of a
-- wallet being reused across chains by accident. It is still its own column for
-- the same reason as the others: settlement destinations are per chain.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS payout_wallet_btc TEXT;

COMMENT ON COLUMN clients.payout_wallet_btc IS
  'Bitcoin settlement address (bech32 bc1…/tb1…, or legacy). NULL = BTC payouts '
  'not enabled.';

-- ---------- listener cursor ---------------------------------------------------
-- Advisory only, like TRC20's. The Bitcoin listener is ADDRESS-driven (Esplora
-- indexes by address; there is no practical "give me every payment to this set
-- in block range X..Y" query), so it records the tip here for observability but
-- does not resume from it.
INSERT INTO chain_cursor (network, last_scanned_block) VALUES ('BTC', 0)
ON CONFLICT (network) DO NOTHING;

-- ---------- assets -----------------------------------------------------------
-- Enabled, not disabled — see note 1 in the header. BTC is the only asset this
-- network has.
INSERT INTO assets (network, symbol, display_name, enabled, sort_order) VALUES
  ('BTC', 'BTC', 'Bitcoin', true, 10)
ON CONFLICT (network, symbol) DO NOTHING;

COMMIT;
