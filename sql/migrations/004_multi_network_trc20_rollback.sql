-- =============================================================================
-- 004 ROLLBACK — revert multi-network support back to BEP20-only.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/004_multi_network_trc20_rollback.sql
--
-- Use this ONLY if you are also reverting the application code to a pre-TRC20
-- build. The added `network` columns are harmless to the old code (it ignores
-- them), so the only strictly necessary revert is chain_cursor's shape — but the
-- full teardown is provided for completeness.
--
-- !! DESTRUCTIVE !!
--   Refuses to run while any TRC20 payment exists, because dropping these
--   columns would silently reinterpret Tron rows as BEP20 — i.e. it would point
--   sweeps and payouts at the wrong chain. Settle or expire TRC20 payments first.
-- =============================================================================

BEGIN;

DO $$
DECLARE trc20_count INT;
BEGIN
  SELECT COUNT(*) INTO trc20_count FROM payments WHERE network = 'TRC20';
  IF trc20_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % TRC20 payment(s) exist. Dropping payments.network would '
      'silently relabel them as BEP20 and point settlement at the wrong chain.', trc20_count;
  END IF;
END $$;

-- ---------- chain_cursor: back to the single-row shape -----------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'chain_cursor' AND column_name = 'network'
  ) THEN
    DELETE FROM chain_cursor WHERE network <> 'BEP20';
    ALTER TABLE chain_cursor DROP CONSTRAINT chain_cursor_pkey;
    ALTER TABLE chain_cursor DROP COLUMN network;
    ALTER TABLE chain_cursor ADD COLUMN id INT DEFAULT 1;
    UPDATE chain_cursor SET id = 1;
    ALTER TABLE chain_cursor ALTER COLUMN id SET NOT NULL;
    ALTER TABLE chain_cursor ADD PRIMARY KEY (id);
    ALTER TABLE chain_cursor ADD CONSTRAINT chain_cursor_id_check CHECK (id = 1);
  END IF;
END $$;

INSERT INTO chain_cursor (id, last_scanned_block) VALUES (1, 0) ON CONFLICT DO NOTHING;

-- ---------- drop the network columns ----------------------------------------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_network_check;
DROP INDEX IF EXISTS idx_payments_network_status;

ALTER TABLE wallets                 DROP COLUMN IF EXISTS network;
ALTER TABLE blockchain_transactions DROP COLUMN IF EXISTS network;
ALTER TABLE payouts                 DROP COLUMN IF EXISTS network;
ALTER TABLE admin_withdrawals       DROP COLUMN IF EXISTS network;
ALTER TABLE clients                 DROP COLUMN IF EXISTS payout_wallet_trc20;

COMMIT;
