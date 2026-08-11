-- Rollback for 017_late_deposit_reaper_index.sql
--
-- Dropping this only makes the settle tick's late-payment reaper slower; it
-- does not change any behaviour, and no data is lost.

BEGIN;

DROP INDEX IF EXISTS idx_payments_expired_recent;

COMMIT;
