-- =============================================================================
-- Rollback for 025_unexpected_deposit_payment_index.sql
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/025_unexpected_deposit_payment_index_rollback.sql
--
-- NO BEGIN/COMMIT — DROP INDEX CONCURRENTLY cannot run inside a transaction
-- block, same as the forward file.
--
-- Dropping this index changes no result and loses no data. The checkout's
-- late-payment guard keeps working; the EXISTS behind it simply gets more
-- expensive.
-- =============================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_unexpected_payment;
