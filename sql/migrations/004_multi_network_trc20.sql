-- =============================================================================
-- 004 — Multi-network support (add TRC20 / Tron alongside BEP20)
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/004_multi_network_trc20.sql
--
-- SAFETY / BACK-COMPAT
--   Every existing row is BEP20 by definition — that is the only network the
--   gateway could settle before this migration. So every `network` column added
--   here defaults to 'BEP20' and backfills to 'BEP20', which means:
--     * no existing payment, payout, wallet or tx changes meaning;
--     * a rollback to the previous code keeps working, because the old code
--       simply ignores these columns (the one exception is chain_cursor — see
--       the note there).
--   The migration is idempotent: re-running it is a no-op.
-- =============================================================================

BEGIN;

-- ---------- wallets: which chain is this address on? -------------------------
-- Deposit addresses are chain-specific (0x… on BSC, T… on Tron). The sweeper
-- needs to know which adapter owns a wallet without joining back to payments.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'BEP20';
CREATE INDEX IF NOT EXISTS idx_wallets_network ON wallets(network);

-- NOTE: idx_wallets_deriv (UNIQUE derivation_index WHERE type='deposit') is left
-- exactly as-is on purpose. Both chains draw indexes from the single hd_counter,
-- so an index is never reused across networks and stays globally unique. That is
-- what lets a wallet row identify its key unambiguously.

-- ---------- payments ---------------------------------------------------------
-- payments.network already exists (TEXT NOT NULL DEFAULT 'BEP20') from the
-- initial schema; it was cosmetic until now. Constrain it to known networks and
-- index the listener's hot path.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_network_check;
ALTER TABLE payments ADD CONSTRAINT payments_network_check
  CHECK (network IN ('BEP20','TRC20'));

-- The per-network listener scans by (network, status).
CREATE INDEX IF NOT EXISTS idx_payments_network_status ON payments(network, status);

-- ---------- blockchain_transactions ------------------------------------------
ALTER TABLE blockchain_transactions
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'BEP20';
CREATE INDEX IF NOT EXISTS idx_btx_network ON blockchain_transactions(network);

-- ---------- payouts ----------------------------------------------------------
-- A payout settles on one chain, from that chain's central wallet.
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'BEP20';
CREATE INDEX IF NOT EXISTS idx_payouts_network ON payouts(network);

-- ---------- admin_withdrawals ------------------------------------------------
ALTER TABLE admin_withdrawals
  ADD COLUMN IF NOT EXISTS network TEXT NOT NULL DEFAULT 'BEP20';

-- ---------- clients: per-network payout wallet -------------------------------
-- `payout_wallet` keeps its exact current meaning: the merchant's BEP20 address.
-- It is NOT migrated or renamed, so existing merchants are untouched. TRC20
-- settlement is opt-in per merchant: a NULL payout_wallet_trc20 simply means
-- "this merchant does not take TRC20 payouts yet" and auto-payout skips them
-- rather than failing.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS payout_wallet_trc20 TEXT;

COMMENT ON COLUMN clients.payout_wallet IS
  'BEP20 (0x…) settlement address. See payout_wallet_trc20 for Tron.';
COMMENT ON COLUMN clients.payout_wallet_trc20 IS
  'TRC20 (base58 T…) settlement address. NULL = merchant has not enabled TRC20 payouts.';

-- ---------- chain_cursor: one scan cursor PER NETWORK ------------------------
-- Was a single-row table (id INT PRIMARY KEY CHECK (id = 1)) — there was nowhere
-- to store a second chain's cursor. Re-key it on `network`, preserving the
-- existing BSC cursor value so the BEP20 listener resumes exactly where it left
-- off (rescanning from 0 would be slow, not incorrect — but we avoid it anyway).
--
-- ROLLBACK NOTE: this is the one structurally breaking change. Old code queries
-- `WHERE id = 1`; after this migration that column is gone. Roll back the schema
-- with 004_multi_network_trc20_rollback.sql if you revert the code.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'chain_cursor' AND column_name = 'id'
  ) THEN
    ALTER TABLE chain_cursor ADD COLUMN IF NOT EXISTS network TEXT;
    UPDATE chain_cursor SET network = 'BEP20' WHERE network IS NULL;
    ALTER TABLE chain_cursor ALTER COLUMN network SET NOT NULL;
    -- Dropping `id` also drops its PK and the id = 1 CHECK.
    ALTER TABLE chain_cursor DROP COLUMN id;
    ALTER TABLE chain_cursor ADD PRIMARY KEY (network);
  END IF;
END $$;

-- Seed a cursor for every supported network. TRC20 starts at 0; the Tron
-- listener is timestamp-driven per address and treats 0 as "no floor yet", so
-- this is safe and does not trigger a historical rescan.
INSERT INTO chain_cursor (network, last_scanned_block) VALUES ('BEP20', 0)
  ON CONFLICT (network) DO NOTHING;
INSERT INTO chain_cursor (network, last_scanned_block) VALUES ('TRC20', 0)
  ON CONFLICT (network) DO NOTHING;

COMMIT;
