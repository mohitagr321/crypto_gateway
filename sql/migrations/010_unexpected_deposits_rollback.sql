-- =============================================================================
-- 010 ROLLBACK — remove wrong-asset deposit tracking.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/010_unexpected_deposits_rollback.sql
--
-- !! READ THIS BEFORE RUNNING !!
--   Dropping this table does NOT lose the funds — an unexpected deposit sits at
--   an HD deposit address whose key is derivable from the mnemonic, and
--   backend/src/recover.ts can still sweep it by index. But it DOES lose the
--   record of which addresses hold stray funds, and without that record nobody
--   knows to go looking.
--
--   So this refuses to run while any row is unresolved. Sweep or write off the
--   outstanding ones first; a row that reached 'swept' or 'converted' has
--   already had its funds moved and is safe to discard.
-- =============================================================================

BEGIN;

DO $$
DECLARE open_count INT;
BEGIN
  IF to_regclass('unexpected_deposits') IS NOT NULL THEN
    SELECT COUNT(*) INTO open_count FROM unexpected_deposits
     WHERE status NOT IN ('swept','converted');
    IF open_count > 0 THEN
      RAISE EXCEPTION
        'Refusing to roll back: % unexpected deposit(s) are still unresolved. '
        'Their funds are at HD deposit addresses and this table is the only '
        'record of WHICH ones. Sweep them (backend/src/recover.ts) or mark them '
        'resolved first.', open_count;
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_unexpected_deposits_updated ON unexpected_deposits;
DROP INDEX IF EXISTS idx_unexpected_status;
DROP INDEX IF EXISTS idx_unexpected_client;
DROP TABLE IF EXISTS unexpected_deposits;

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_slippage_check;
ALTER TABLE clients DROP COLUMN IF EXISTS max_slippage_bps;
ALTER TABLE clients DROP COLUMN IF EXISTS auto_convert_unexpected;

COMMIT;
