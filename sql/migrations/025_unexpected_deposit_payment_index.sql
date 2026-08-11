-- =============================================================================
-- 025 — index unexpected_deposits(payment_id)
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/025_unexpected_deposit_payment_index.sql
-- Rollback:  sql/migrations/025_unexpected_deposit_payment_index_rollback.sql
--
-- !! NO BEGIN/COMMIT ON PURPOSE — CREATE INDEX CONCURRENTLY cannot run inside a
--    transaction block. psql runs the file in autocommit, statement by
--    statement, which is what is wanted: no ACCESS EXCLUSIVE lock on a live
--    table. IF NOT EXISTS makes the file re-runnable. If a concurrent build
--    fails it leaves an INVALID index behind: find it with
--      SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--    DROP INDEX CONCURRENTLY that name, and re-run.
--
-- WHY
--   The hosted checkout derives "has this link been used?" from the link's
--   payments, and a payment only releases its use if it is dead, received
--   nothing, AND left no row in unexpected_deposits (see
--   backend/src/services/paymentLinkService.ts). That last term is what stops a
--   LATE payment — money that arrived after the payment expired, which no
--   listener ever credits and which the settle tick records here instead — from
--   re-opening a single-use invoice link the customer has in fact already paid.
--
--   Without this index that EXISTS is a sequential scan of unexpected_deposits,
--   evaluated once per dead-and-empty payment, on the merchant's link list (up
--   to 200 links) as well as on every public checkout open. The table is small
--   by nature — it is the exception ledger — but small times a few thousand
--   evaluations a minute is still real work, and it grows forever.
--
-- PURELY PERFORMANCE. No column, no constraint, no state, no behaviour depends
-- on it: the query returns identical rows with or without it. Safe to apply at
-- any time, safe to defer, safe to roll back, not gated on a code deploy. The
-- correctness of the checkout gate does NOT require this index — only its cost.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unexpected_payment
  ON unexpected_deposits (payment_id)
  WHERE payment_id IS NOT NULL;

ANALYZE unexpected_deposits;
