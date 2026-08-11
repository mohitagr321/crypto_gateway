-- =============================================================================
-- 015 ROLLBACK — return commissions to a denomination-less number.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/015_commission_denomination_rollback.sql
--
-- Use this ONLY if you are also reverting the application code to a build
-- without commission denominations. The added columns are inert to the old code
-- (it selects `*` but reads neither), so rolling the code back alone is safe and
-- is the preferred order.
--
-- !! DESTRUCTIVE !!
--   Refuses to run while a non-USDT amount-denominated commission exists.
--   Dropping `asset` would turn "0.0005 BTC" back into a bare "0.0005" that the
--   old code applies to whatever asset the payment arrived in — reinstating the
--   exact fund-loss this migration exists to close.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  bad_rows INT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'commissions' AND column_name = 'asset'
  ) THEN
    SELECT COUNT(*) INTO bad_rows
      FROM commissions
     WHERE is_active
       AND type IN ('fixed', 'tiered')
       AND asset IS DISTINCT FROM 'USDT';
    IF bad_rows > 0 THEN
      RAISE EXCEPTION
        'Refusing to roll back: % active fixed/tiered commission(s) are denominated '
        'in something other than USDT. Dropping commissions.asset would leave a bare '
        'number that the pre-015 code applies to whichever asset the payment arrived '
        'in — a fixed fee meaning one dollar becomes one whole coin. Move those '
        'clients to a percentage rate, or to a USDT-denominated fee, first.', bad_rows;
    END IF;
  END IF;
END $$;

ALTER TABLE commissions DROP CONSTRAINT IF EXISTS chk_commissions_denomination;

DROP INDEX IF EXISTS idx_commissions_client_scope;

-- The balance indexes are pure performance and harmless to keep, but they are
-- this migration's to remove.
DROP INDEX IF EXISTS idx_admin_withdrawals_network_asset_status;
DROP INDEX IF EXISTS idx_payouts_network_asset_status;
DROP INDEX IF EXISTS idx_btx_sweep_network_asset;

-- admin_withdrawals.asset predates this migration (008) and is NOT dropped here.
ALTER TABLE commissions DROP COLUMN IF EXISTS network;
ALTER TABLE commissions DROP COLUMN IF EXISTS asset;

COMMIT;
