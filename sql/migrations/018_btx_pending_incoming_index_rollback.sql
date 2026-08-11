-- Rollback for 018_btx_pending_incoming_index.sql
--
-- Dropping this only makes each listener pass scan blockchain_transactions
-- sequentially again. No behaviour changes and no data is lost.

BEGIN;

DROP INDEX IF EXISTS idx_btx_pending_incoming;

COMMIT;
