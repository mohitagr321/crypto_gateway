-- =============================================================================
-- 016 ROLLBACK — drop the one-live-payout-per-payment index.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/016_payout_unresolved_rollback.sql
--
-- !! READ THIS BEFORE RUNNING !!
--   THE ENUM VALUE IS NOT REMOVED. PostgreSQL has no `ALTER TYPE ... DROP
--   VALUE`, and dropping it would require rewriting the type and every column
--   using it (payouts.status AND admin_withdrawals.status). Leaving
--   `unresolved` in place is harmless: nothing writes it once the backend is
--   rolled back, and it sorts last.
--
--   RUNNING THIS WHILE ANY ROW IS `unresolved` IS A FUND-LOSS RISK. Those rows
--   are payouts whose transaction may already be on chain. Without the index,
--   the only thing keeping a second transfer from being created is the status
--   predicates in the application — which is exactly what the old code got
--   wrong. Reconcile every `unresolved` row against the explorer FIRST.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  unresolved_count INT := 0;
BEGIN
  SELECT COUNT(*) INTO unresolved_count FROM payouts WHERE status = 'unresolved';
  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % payout(s) are unresolved — each may already be '
      'on chain. Check the explorer for each and set it to sent/confirmed (it '
      'landed) or failed (it did not) before dropping the guard index.',
      unresolved_count;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_payouts_needs_operator;
DROP INDEX IF EXISTS uq_payouts_active_payment;

COMMIT;
