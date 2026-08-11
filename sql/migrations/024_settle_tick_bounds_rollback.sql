-- Rollback for 024_settle_tick_bounds.sql
--
-- ROLL THE WORKER BACK FIRST. backend/src/workers/index.ts selects, orders by
-- and writes all three of these columns; dropping them under a running worker
-- makes every settle tick throw, which switches off the sweep re-drive, the
-- payout re-drive, the late-deposit reaper and the webhook redelivery pass at
-- once. The safety net failing silently is the worst state this system has.
--
-- Nothing here loses money or history. settle_attempts and settle_done_at are
-- bookkeeping the tick rebuilds for itself (settle_done_at from `payouts`, which
-- is untouched); redelivered_at only records that a webhook was re-queued, and
-- the deliveries themselves are in webhook_logs either way.
--
-- What you get back by dropping them is the OLD behaviour, defects included: an
-- unbounded once-a-minute scan of every payment ever swept, and a settle pass
-- whose 500-row head can be occupied forever by rows that can never progress.

BEGIN;

DROP INDEX IF EXISTS idx_webhook_logs_group;
DROP INDEX IF EXISTS idx_webhook_logs_redeliver;
ALTER TABLE webhook_logs DROP COLUMN IF EXISTS redelivered_at;

-- idx_payouts_payment is deliberately NOT dropped: 020_hot_path_indexes.sql
-- creates the same index for the admin payout lookups, and dropping it here
-- would silently undo that migration. It is a pure performance index either way.
DROP INDEX IF EXISTS idx_payments_settle_pending;
DROP INDEX IF EXISTS idx_payments_settle_confirmed;
ALTER TABLE payments DROP COLUMN IF EXISTS settle_done_at;
ALTER TABLE payments DROP COLUMN IF EXISTS settle_attempts;

COMMIT;
