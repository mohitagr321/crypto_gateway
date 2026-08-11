-- =============================================================================
-- 022 — covering indexes for the payout balance guard, and an ordering index
--       for the merchant payout list
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/022_balance_and_list_indexes.sql
-- Rollback:  sql/migrations/022_balance_and_list_indexes_rollback.sql
--
-- THIS MIGRATION IS PURELY PERFORMANCE.
--   It adds three indexes. No column, no constraint, no enum value, no state.
--   Every query it supports is already CORRECT without it and returns exactly
--   the same rows either way — it is safe to apply at any time, safe to defer,
--   and safe to roll back. It is deliberately not gated on a code deploy.
--
-- ---------------------------------------------------------------------------
-- 1 + 2. idx_payments_bal / idx_payouts_bal — the payout balance guard
-- ---------------------------------------------------------------------------
--   backend/src/services/payoutService.ts getBalanceWith is read INSIDE
--   pg_advisory_xact_lock(client, network) and on the transaction's own
--   connection, so it holds the lock for every payout decision that merchant
--   makes on that chain until COMMIT. It sums the merchant's ENTIRE lifetime
--   payment and payout history, and that row count only grows.
--
--   The existing indexes already match the predicate on their leading columns:
--       idx_payments_client_network_asset_status (client_id, network, asset, status)
--       idx_payouts_client_network_asset_status  (client_id, network, asset, status)
--   so these are index scans, not sequential scans. What they are NOT is
--   index-ONLY scans: `amount_received`, `amount` and `gross_amount` appear in no
--   index, so every matching row still costs a heap fetch. At 100k coins/day
--   that heap traffic is the whole cost, and it is paid under the lock.
--
--   INCLUDE puts the summed columns in the leaf pages without widening the
--   B-tree key, so the aggregates can be answered from the index alone wherever
--   the visibility map is clean. Same rows, same numbers, no heap.
--
--   The column ORDER matches the existing indexes exactly, because the balance
--   is per (client, network, asset) and MUST STAY THAT WAY — BEP20 USDT and
--   TRC20 USDT are not fungible and a payout may never draw on the other's
--   balance. An index that dropped `asset` from the key would still answer the
--   query, but it would invite exactly the aggregate this system must not do.
--
--   These do not replace idx_payments_client_network_asset_status or
--   idx_payouts_client_network_asset_status: those still serve every lookup that
--   needs other columns, and dropping them is not part of this change.
--
-- ---------------------------------------------------------------------------
-- 3. idx_payouts_client_created — GET /api/v1/payouts
-- ---------------------------------------------------------------------------
--   backend/src/routes/payouts.ts is now paginated and orders by
--   (created_at DESC, id DESC). payouts had NO index on (client_id, created_at)
--   at all — only idx_payouts_client (client_id) and three network-leading
--   composites — so the ORDER BY was an external sort of the merchant's whole
--   payout slice on every page load. The id tiebreak is in the key because the
--   route needs a TOTAL order: created_at is not unique (the settle tick can
--   create several payouts in the same millisecond) and an unstable tie break
--   makes a row appear on two pages or on none.
--
--   It also serves the row COUNT on that route, and the admin payout list's
--   per-client filter.
--
-- ---------------------------------------------------------------------------
-- LOCKING
--   CREATE INDEX takes a brief ACCESS EXCLUSIVE lock on the table, which on a
--   busy payments/payouts table blocks writes for the duration of the build. On
--   a live gateway prefer the CONCURRENTLY form, which CANNOT run inside a
--   transaction block — so run these three statements individually instead of
--   this file:
--
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_bal
--       ON payments (client_id, network, asset, status)
--       INCLUDE (amount_received, amount);
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_bal
--       ON payouts (client_id, network, asset, status)
--       INCLUDE (gross_amount);
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_client_created
--       ON payouts (client_id, created_at DESC, id DESC);
--
--   Then ANALYZE payments, payouts — the planner will not choose an index-only
--   scan on stale statistics, and /admin/transactions, /admin/payouts and
--   /admin/webhook-logs now read pg_class.reltuples for their unfiltered page
--   counts, which is only as good as the last ANALYZE.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_payments_bal
  ON payments (client_id, network, asset, status)
  INCLUDE (amount_received, amount);

CREATE INDEX IF NOT EXISTS idx_payouts_bal
  ON payouts (client_id, network, asset, status)
  INCLUDE (gross_amount);

CREATE INDEX IF NOT EXISTS idx_payouts_client_created
  ON payouts (client_id, created_at DESC, id DESC);

COMMIT;

-- Outside the transaction: refresh statistics so the planner can actually pick
-- the index-only scans above. Harmless to re-run.
ANALYZE payments;
ANALYZE payouts;
