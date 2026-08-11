-- =============================================================================
-- 017 — index for the late-payment reaper
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/017_late_deposit_reaper_index.sql
-- Rollback:  sql/migrations/017_late_deposit_reaper_index_rollback.sql
--
-- WHY
--   The settle tick (backend/src/workers/index.ts, reapLateDeposits) now reads
--   the on-chain balance of deposit addresses whose payment has recently
--   EXPIRED, so funds that arrive after the expiry stop being invisible and
--   land in `unexpected_deposits` where an operator can recover them.
--
--   Its candidate query is
--       WHERE status = 'expired' AND expires_at > now() - interval '24 hours'
--       ORDER BY expires_at DESC
--   and it runs every minute, forever. `idx_payments_status` alone would make
--   that walk every expired payment ever taken — a set that only grows, and
--   most payments expire — to find the handful from the last day.
--
--   `idx_payments_expires` does not help: it is PARTIAL on
--   status IN ('waiting','confirming') and deliberately excludes this one.
--
-- THIS MIGRATION IS PURELY A PERFORMANCE INDEX.
--   The reaper is correct without it; it is just slower, and gets slower with
--   age. Nothing in the application reads or writes anything new here — no
--   column, no constraint, no state. It is safe to apply at any time and safe
--   to defer, which is why it is not gated on a code deploy.
--
--   CREATE INDEX takes a brief ACCESS EXCLUSIVE lock. On a live gateway prefer
--   the CONCURRENTLY form, which cannot run inside a transaction block — so
--   run the single statement below on its own instead of this file:
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_expired_recent
--         ON payments(expires_at DESC) WHERE status = 'expired';
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_payments_expired_recent
  ON payments(expires_at DESC)
  WHERE status = 'expired';

COMMIT;
