-- =============================================================================
-- Rollback for 020_hot_path_indexes.sql
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/020_hot_path_indexes_rollback.sql
--
-- !! NO BEGIN/COMMIT ON PURPOSE — see the header of the forward migration. !!
--
-- Dropping these indexes loses no data and changes no result: 020 was purely
-- performance, so this rollback is purely a return to the slower plans. Every
-- statement is IF EXISTS / IF NOT EXISTS, so it is safe to run against a
-- database where 020 was only partly applied.
--
-- SHARED INDEXES ARE NOT DROPPED HERE. Three of the indexes 020 creates are
-- also created by OTHER migrations, and this rollback used to drop all three —
-- so rolling back 020 silently rolled back part of 018, 022 and 024 as well,
-- leaving those migrations "applied" while the index they exist to add was
-- gone. Ownership is now by apply order (first file to create it owns it):
--
--   idx_btx_pending_incoming     -> 018_btx_pending_incoming_index
--   idx_payouts_client_created   -> 020 owns it; 022 re-creates IF NOT EXISTS
--   idx_payouts_payment          -> 020 owns it; 024 re-creates IF NOT EXISTS
--
-- idx_btx_pending_incoming is therefore left alone below (roll back 018 to drop
-- it). idx_payouts_client_created and idx_payouts_payment ARE dropped here
-- because 020 is the first file to create them — but if 022 or 024 is still
-- applied, re-run that file afterwards, or comment the two lines out.
--
-- idx_payments_status is RECREATED, because 020 dropped it. It is recreated
-- CONCURRENTLY and last, so a rollback under load does not lock the payments
-- table. If the operator chose to skip the DROP when applying 020, the
-- IF NOT EXISTS makes this a no-op.
-- =============================================================================

DROP INDEX CONCURRENTLY IF EXISTS idx_payments_client_status_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_payouts_client_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_payouts_payment;
DROP INDEX CONCURRENTLY IF EXISTS idx_payouts_created;
DROP INDEX CONCURRENTLY IF EXISTS idx_webhook_logs_created;
-- idx_btx_pending_incoming is owned by 018_btx_pending_incoming_index — see the
-- header. Roll THAT file back if the index is meant to go.
DROP INDEX CONCURRENTLY IF EXISTS idx_payments_confirmed;
DROP INDEX CONCURRENTLY IF EXISTS idx_payments_swept;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_status ON payments (status);

ANALYZE payments;
ANALYZE payouts;
ANALYZE blockchain_transactions;
ANALYZE webhook_logs;
