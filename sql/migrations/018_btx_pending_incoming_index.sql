-- =============================================================================
-- 018 — index for the listeners' pending-transaction sweep
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/018_btx_pending_incoming_index.sql
-- Rollback:  sql/migrations/018_btx_pending_incoming_index_rollback.sql
--
-- WHY
--   Every listener (evmListener, tronListener, bitcoinListener) drives its
--   confirmation and promotion work off the same predicate, once per pass,
--   forever:
--
--       WHERE direction = 'incoming'
--         AND status    = 'pending'
--         AND network   = '<this chain>'
--         AND block_number IS NOT NULL
--
--   blockchain_transactions carries idx_btx_payment, idx_btx_to, idx_btx_block,
--   idx_btx_network, idx_btx_network_asset and UNIQUE (tx_hash, log_index) —
--   nothing on (direction, status). `network` is effectively single-valued per
--   deployment, so idx_btx_network selects the whole table. That leaves a
--   sequential scan of a table that is never pruned, run every 5 seconds by
--   every listener, to find a working set bounded by the payments currently in
--   flight.
--
--   The partial index is the whole in-flight set and nothing else: it holds
--   only rows that are still `pending`, and a row leaves it for good the moment
--   it is confirmed or reorged. It stays small no matter how large the table
--   gets, which is exactly the property the driving predicate needs.
--
--   `block_number` is the indexed column because the EVM listener now bounds
--   that scan by block as well (see confirmationWindowBlocks in
--   backend/src/blockchain/evmListener.ts), so the range is served by the index
--   rather than by a filter after the fact.
--
-- THIS MIGRATION IS PURELY A PERFORMANCE INDEX.
--   No column, no constraint, no state, no behaviour. Every listener is correct
--   without it and simply does more work; it is safe to apply at any time, safe
--   to defer, and safe to apply before or after the code that benefits from it.
--
--   CREATE INDEX takes a brief ACCESS EXCLUSIVE lock. On a live gateway prefer
--   the CONCURRENTLY form, which cannot run inside a transaction block — so run
--   the single statement below on its own instead of this file:
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_btx_pending_incoming
--         ON blockchain_transactions (network, block_number)
--         WHERE direction = 'incoming' AND status = 'pending';
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_btx_pending_incoming
  ON blockchain_transactions (network, block_number)
  WHERE direction = 'incoming' AND status = 'pending';

COMMIT;
