-- =============================================================================
-- 012 ROLLBACK — remove the native coin rows.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/012_native_coins_rollback.sql
--
-- !! READ THIS BEFORE RUNNING !!
--   This removes only DISPLAY rows. It does not disable native payments — that
--   is `ACCEPT_NATIVE_COINS` in env — and it does not touch any payment,
--   transaction or balance. A merchant who has been paid in BNB still holds
--   that balance afterwards.
--
--   It refuses while any payment in a native asset is still live, because
--   dropping the row that names the coin, mid-payment, leaves a settlement the
--   panel cannot label. Let those finish (or expire) first.
-- =============================================================================

BEGIN;

DO $$
DECLARE live_native INT := 0;
BEGIN
  SELECT COUNT(*) INTO live_native
    FROM payments
   WHERE asset IN ('BNB','TRX')
     AND status IN ('waiting','confirming','partial','confirmed');

  IF live_native > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % payment(s) in a native coin are still live. '
      'Their funds are at HD deposit addresses awaiting a sweep. Let them '
      'settle or expire first — and note that disabling native payments is '
      'ACCEPT_NATIVE_COINS=false in env, not this migration.', live_native;
  END IF;
END $$;

DELETE FROM assets WHERE (network, symbol) IN (('BEP20','BNB'), ('TRC20','TRX'));

COMMENT ON TABLE assets IS
  'Enable/display state for assets. Contract addresses and decimals live in '
  'backend/src/blockchain/assets.ts and are NOT configurable here — a wrong '
  'value in either is a fund-loss bug.';

COMMIT;
