-- =============================================================================
-- 020 — indexes for six hot-path predicates that had none
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/020_hot_path_indexes.sql
-- Rollback:  sql/migrations/020_hot_path_indexes_rollback.sql
--
-- !! THIS FILE HAS NO BEGIN/COMMIT ON PURPOSE. !!
--   Every statement is CREATE/DROP INDEX CONCURRENTLY, which POSTGRES REFUSES
--   to run inside a transaction block. psql runs a file statement-by-statement
--   in autocommit, which is exactly what is wanted here: each index builds
--   without taking a write lock on a live table, and if one fails the ones
--   before it are already committed. Re-running the file is safe — every
--   statement is IF NOT EXISTS / IF EXISTS.
--
--   A failed CONCURRENTLY build leaves an INVALID index behind, which is not
--   used by the planner but is still maintained on write. If a statement below
--   errors, check `SELECT indexrelid::regclass FROM pg_index WHERE NOT
--   indisvalid;`, DROP INDEX CONCURRENTLY whatever it names, and re-run.
--
-- THIS MIGRATION IS PURELY PERFORMANCE.
--   No column, no constraint, no state, no application behaviour depends on it.
--   Every query below returns the same rows in the same order with or without
--   these indexes. It is safe to apply at any time, safe to defer, and safe to
--   roll back, and it is deliberately not gated on a code deploy.
--
-- WHY EACH ONE
--   1. payments(client_id, status, created_at DESC)
--      The merchant payment list — paymentService.listPayments — filters
--      client_id + status and sorts created_at DESC. The existing
--      (client_id, created_at DESC) index has to read the client's whole
--      history and filter; the (client_id, network, asset, status) one cannot
--      serve the sort. This is the index a merchant with a year of payments
--      needs to open page 1 of "confirmed".
--
--   2. payouts(client_id, created_at DESC, id DESC)
--      Same shape for the settlements list. `id DESC` is a deterministic
--      tie-break so keyset pagination over payouts created in the same
--      millisecond cannot repeat or skip a row.
--
--   3. payouts(payment_id) WHERE payment_id IS NOT NULL
--      The settle tick's once-a-minute anti-join ("swept payments with no live
--      payout") and its stalled-payout alarm both look payouts up BY PAYMENT.
--      uq_payouts_active_payment cannot serve them: it is partial on
--      `status <> 'failed'`, and these predicates deliberately include failed
--      rows. Without this the anti-join scans all of payouts every minute.
--
--   4. payouts(created_at DESC)   — the admin payout list, unfiltered.
--   5. webhook_logs(created_at DESC)
--      The admin webhook log, unfiltered. idx_webhook_logs_client is
--      (client_id, created_at DESC) and cannot serve a sort with no client.
--
--   6. blockchain_transactions(network, block_number)
--        WHERE direction = 'incoming' AND status = 'pending'
--      The confirmation-count sweep every listener runs on every pass: the set
--      of still-pending incoming transfers is tiny and permanently hot, while
--      the table it lives in only ever grows. idx_btx_network does not cover
--      the direction/status predicate, and idx_btx_sweep_network_asset is
--      partial on the WRONG pair (direction='sweep' AND status='confirmed').
--
--   7. payments(confirmed_at NULLS FIRST) WHERE status = 'confirmed'
--      processSettle selects `status = 'confirmed' ORDER BY confirmed_at ASC
--      NULLS FIRST LIMIT n` every minute, and the stall alarm reads
--      `confirmed_at < now() - interval '15 minutes'` off the same slice.
--      DELIBERATE DEVIATION from the audit's plain `(confirmed_at)`: the index
--      is built NULLS FIRST so it matches that ORDER BY exactly and can be read
--      as an ordered scan. A default (NULLS LAST) index serves the range
--      predicate but not the sort, which is the leg that matters — that query
--      is what drains a sweep backlog in order.
--
--   8. payments(updated_at) WHERE status = 'swept'
--      The settle tick's payout-recovery pass and the held-payout alarm both
--      start from the swept slice, oldest first.
--
-- OVERLAP WITH THE 018_* MIGRATIONS
--   Two of the statements below — idx_payouts_client_created and
--   idx_btx_pending_incoming — are also created by 018_balance_and_list_indexes
--   and 018_btx_pending_incoming_index, with IDENTICAL definitions. They are
--   kept here rather than assumed, so this file stands on its own if either of
--   those is dropped or reordered. Everything is IF NOT EXISTS, so whichever
--   runs first wins and the other is a no-op; applying them in either order, or
--   both, leaves exactly one index. Do NOT "deduplicate" by deleting the
--   statement from one file without checking the other still exists.
--
--   9. DROP idx_payments_status.
--      `payments.status` is a 7-value enum and 'swept' is the terminal state of
--      every successful payment, so a plain btree on it is not selective enough
--      to be chosen for the statuses that matter and is pure write
--      amplification on the hottest table in the system. Every status-only
--      predicate left in the codebase is covered without it:
--        status IN ('waiting','confirming')  -> idx_payments_expires (partial,
--                                               predicate matches exactly)
--        status = 'expired' AND recent       -> idx_payments_expired_recent (017)
--        status = 'confirmed'                -> idx_payments_confirmed (7 above)
--        status = 'swept'                    -> idx_payments_swept (8 above)
--        status IN ('confirmed','swept')     -> BitmapOr of 7 and 8; and these
--                                               are the unfiltered admin SUM
--                                               aggregates, which touch most of
--                                               the table and were never going
--                                               to use an index anyway.
--      This is the one statement here an operator may reasonably skip: keeping
--      the index costs write throughput, it does not break anything. Skipping
--      it is why the rollback recreates it independently.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_client_status_created
  ON payments (client_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_client_created
  ON payouts (client_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_payment
  ON payouts (payment_id)
  WHERE payment_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_created
  ON payouts (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_logs_created
  ON webhook_logs (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_btx_pending_incoming
  ON blockchain_transactions (network, block_number)
  WHERE direction = 'incoming' AND status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_confirmed
  ON payments (confirmed_at NULLS FIRST)
  WHERE status = 'confirmed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_swept
  ON payments (updated_at)
  WHERE status = 'swept';

DROP INDEX CONCURRENTLY IF EXISTS idx_payments_status;

-- Fresh statistics, so the planner actually starts using the above rather than
-- waiting for autovacuum to notice. Cheap; ANALYZE takes no exclusive lock.
ANALYZE payments;
ANALYZE payouts;
ANALYZE blockchain_transactions;
ANALYZE webhook_logs;
