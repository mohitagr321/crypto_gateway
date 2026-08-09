-- =============================================================================
-- 008 ROLLBACK — return to a single-asset (USDT-only) ledger.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/008_multi_asset_rollback.sql
--
-- Use this ONLY if you are also reverting the application code to a build
-- without multi-asset support. The added columns are inert to the old code (it
-- selects none of them), so rolling the code back alone is already safe.
--
-- !! DESTRUCTIVE !!
--   Refuses to run while any NON-USDT money exists. Dropping `asset` would
--   silently relabel every USDC/BUSD/DAI row as USDT, which would then be:
--     - summed into the USDT balance a merchant can withdraw, and
--     - settled by pointing a USDT transfer at it.
--   That is a direct, irreversible loss. Settle or expire non-USDT payments and
--   payouts first.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  bad_payments INT := 0;
  bad_payouts  INT := 0;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'payments' AND column_name = 'asset'
  ) THEN
    SELECT COUNT(*) INTO bad_payments FROM payments WHERE asset <> 'USDT';
    SELECT COUNT(*) INTO bad_payouts  FROM payouts  WHERE asset <> 'USDT';
    IF bad_payments > 0 OR bad_payouts > 0 THEN
      RAISE EXCEPTION
        'Refusing to roll back: % non-USDT payment(s) and % non-USDT payout(s) exist. '
        'Dropping payments.asset would relabel them as USDT, adding them to a '
        'withdrawable USDT balance and settling them with a USDT transfer. '
        'Settle or expire them first.', bad_payments, bad_payouts;
    END IF;
  END IF;
END $$;

-- ---------- indexes ----------------------------------------------------------
DROP INDEX IF EXISTS idx_payments_client_network_asset_status;
DROP INDEX IF EXISTS idx_payouts_client_network_asset_status;
DROP INDEX IF EXISTS idx_btx_network_asset;

-- ---------- assets table -----------------------------------------------------
DROP TRIGGER IF EXISTS trg_assets_updated ON assets;
DROP TABLE IF EXISTS assets;

-- ---------- columns ----------------------------------------------------------
-- `payments.currency` predates 008 and is left as-is: it held 'USDT' before this
-- migration and (because the guard above proves every row is USDT) still does.
ALTER TABLE clients                 DROP COLUMN IF EXISTS preferred_payout_asset;
ALTER TABLE admin_withdrawals       DROP COLUMN IF EXISTS asset;
ALTER TABLE blockchain_transactions DROP COLUMN IF EXISTS asset;
ALTER TABLE payouts                 DROP COLUMN IF EXISTS asset;
ALTER TABLE payments                DROP COLUMN IF EXISTS asset;

COMMIT;
