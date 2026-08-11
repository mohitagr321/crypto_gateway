-- =============================================================================
-- 026 — at most ONE active commission per (client_id, network, asset)
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/026_one_active_commission_per_scope.sql
-- Rollback:  sql/migrations/026_one_active_commission_per_scope_rollback.sql
--
-- !! NO BEGIN/COMMIT ON PURPOSE — CREATE INDEX CONCURRENTLY cannot run inside a
--    transaction block. psql runs the file in autocommit, statement by
--    statement. If a concurrent build fails it leaves an INVALID index behind:
--      SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--    DROP INDEX CONCURRENTLY that name, and re-run.
--
-- WHY
--   setCommission (backend/src/services/commissionService.ts) versions a
--   commission by deactivating the active row(s) in the scope and inserting a
--   new one, inside a READ COMMITTED transaction. Two operators saving for the
--   same client at once could interleave so that the second transaction's
--   UPDATE found is_active already false while the first transaction's INSERT
--   was still invisible to it — leaving TWO active rows in one scope. Nothing in
--   the schema forbade it: idx_commissions_client_active and
--   idx_commissions_client_scope are both plain indexes.
--
--   The code fix (a `SELECT 1 FROM clients WHERE id = $1 FOR UPDATE` before the
--   pair) is the primary mechanism and does not need this index. This is the
--   backstop that makes the invariant a property of the DATABASE, so a future
--   code path cannot reintroduce the duplicate silently. setCommission catches
--   23505 on it and reports a 409 'changed concurrently'.
--
-- SCOPE, NOT CLIENT
--   The uniqueness key is (client_id, network, asset), NOT client_id alone.
--   Several active rows per client are LEGITIMATE and load-bearing: a client-wide
--   percentage rate plus a BTC-denominated fixed fee plus a TRC20-only rate are
--   three active rows, and getActiveCommission picks between them by
--   specificity. A UNIQUE index on client_id alone would break multi-asset
--   commissioning outright.
--
--   NULL means "any" in both columns and NULLs are DISTINCT in a plain unique
--   index, so the key is expressed with COALESCE over a sentinel. Written this
--   way rather than with `NULLS NOT DISTINCT` so it applies on PostgreSQL below
--   15 as well. '' is safe as the sentinel: network and asset are stored
--   upper-cased and non-empty, or NULL.
--
-- THE DE-DUPLICATION PASS IS SELECTION-NEUTRAL
--   Existing data may already violate the invariant, so the index build would
--   fail without it. It deactivates every active row in a scope EXCEPT the newest
--   (created_at DESC, id DESC) — which is exactly the row getActiveCommission
--   already returns for that scope, since its ordering ranks within a scope by
--   created_at DESC. So no client's effective commission changes: only rows that
--   were already being ignored stop being flagged active. Verify before running:
--
--     SELECT client_id, network, asset, count(*)
--       FROM commissions WHERE is_active
--      GROUP BY 1,2,3 HAVING count(*) > 1;
--
-- ORDER MATTERS: the UPDATE must run before the index build.
-- =============================================================================

UPDATE commissions c
   SET is_active = false
 WHERE c.is_active
   AND c.id <> (
     SELECT c2.id
       FROM commissions c2
      WHERE c2.client_id = c.client_id
        AND c2.is_active
        AND c2.network IS NOT DISTINCT FROM c.network
        AND c2.asset   IS NOT DISTINCT FROM c.asset
      ORDER BY c2.created_at DESC, c2.id DESC
      LIMIT 1
   );

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_commissions_one_active
  ON commissions (client_id, COALESCE(network, ''), COALESCE(asset, ''))
  WHERE is_active;

ANALYZE commissions;
