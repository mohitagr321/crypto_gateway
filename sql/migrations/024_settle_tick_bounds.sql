-- =============================================================================
-- 024 — bound the settle tick, and give webhooks a way back
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/024_settle_tick_bounds.sql
-- Rollback:  sql/migrations/024_settle_tick_bounds_rollback.sql
--
-- ORDER-INDEPENDENT of 020_hot_path_indexes.sql, which creates an identical
-- idx_payouts_payment. Both use IF NOT EXISTS; whichever runs first wins and the
-- other is a no-op. 020's idx_payments_confirmed / idx_payments_swept were sized
-- for the settle tick's OLD ordering and are superseded by the two partial
-- indexes below; they are harmless if kept, and 020 owns dropping them.
--
-- APPLY THIS BEFORE DEPLOYING THE WORKER THAT GOES WITH IT.
--   backend/src/workers/index.ts reads all three columns added here. Deployed
--   the other way round, every settle tick throws and the safety net is off.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- 1. THE PAYOUT PASS RE-SCANNED ALL OF HISTORY, ONCE A MINUTE.
--    The settle tick's step 2 selected every payment in `swept` — the terminal
--    state of every SUCCESSFUL payment, which nothing ever leaves — and
--    anti-joined it against payouts, with no LIMIT, no date bound, and no index
--    on payouts.payment_id. At a hundred thousand payments a day that query's
--    cost only ever goes up, and one settle worker at concurrency 1 means a pass
--    that overruns sixty seconds delays the next tick's sweep pass too.
--
--    `settle_done_at` is the marker that lets it stop looking. It is set ONLY
--    when a payout for that payment has reached a state nothing can move it back
--    out of — sent / confirmed / unresolved, or broadcast_at stamped, which is
--    never cleared anywhere in the codebase. That is a strict subset of the
--    exclusion the query already applied, and it is MONOTONE, so a marked row is
--    provably one the tick would refuse to act on anyway, forever. The full
--    anti-join still runs over everything that survives the marker, so
--    correctness does not depend on this column — only cost does.
--
--    `pending` and `processing` are deliberately NOT markable: a payout that
--    fails BEFORE broadcast is released back to `failed` and the tick is right
--    to mint a fresh one. Marking those would strand the very payments this
--    safety net exists for.
--
-- 2. A 500-ROW CAP, OLDEST FIRST, STARVES.
--    The sweep pass was capped at 500 ordered by confirmed_at. A payment below
--    its asset's minSweep can never leave `confirmed` (on Ethereum that is any
--    ERC20 payment under 20 USDT), so those rows sit at the head of every batch
--    forever and nothing behind them is ever reached.
--
--    `settle_attempts` is incremented for every row a pass SELECTS, and both
--    passes now order by (settle_attempts, confirmed_at). A row with k attempts
--    is only skipped while rows with fewer than k exist, and each pass moves
--    those closer to k — so an over-cap backlog is drained across ticks in a
--    bounded number of them and no row can be starved by another.
--
-- 3. WEBHOOKS HAD NO WAY BACK.
--    Delivery was abandoned after ~11.5 minutes with no redelivery path anywhere
--    in the product: a merchant whose endpoint was down for a fifteen-minute
--    deploy permanently lost payment.confirmed for every payment settled in that
--    window. The retry tail is now shaped by the outage it must survive (24h,
--    capped at one gap per hour), and the settle tick re-drives deliveries the
--    queue never received (the enqueue itself failed) or has given up on.
--    `redelivered_at` is what stops that reaper picking the same row again sixty
--    seconds later, before its new attempt rows exist.
--
-- NOTHING HERE CHANGES A BALANCE. Three additive columns, a backfill of the new
-- marker from facts already in `payouts`, and five indexes.
--
-- CONCURRENTLY. CREATE INDEX takes a brief ACCESS EXCLUSIVE lock. On a live
-- gateway run the five CREATE INDEX statements separately with CONCURRENTLY
-- (which cannot run inside a transaction block) and the rest of this file as it
-- stands.
--
-- THE BACKFILL is a single UPDATE over `swept` payments. On a large table run it
-- in batches instead:
--   UPDATE payments p SET settle_done_at = now()
--    WHERE p.id IN (SELECT id FROM payments
--                    WHERE status='swept' AND settle_done_at IS NULL LIMIT 20000)
--      AND EXISTS (...same EXISTS as below...);
-- repeated until it reports 0 rows. Skipping the backfill entirely is safe: the
-- worker converges on its own, just more slowly.
-- =============================================================================

BEGIN;

-- ---------- payments: settle bookkeeping -------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS settle_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS settle_done_at TIMESTAMPTZ;

COMMENT ON COLUMN payments.settle_attempts IS
  'How many settle-tick passes have SELECTED this payment, whatever the outcome. '
  'Ordering by it makes the tick''s per-pass cap a round-robin instead of a queue '
  'whose head a permanently unsettleable row can occupy forever. Not a money '
  'figure and never summed into one.';
COMMENT ON COLUMN payments.settle_done_at IS
  'Set once a payout for this payment has reached a state nothing moves it back '
  'out of (sent/confirmed/unresolved, or broadcast_at stamped). Purely a scan '
  'bound for the settle tick: the full anti-join still runs over every row this '
  'does not exclude, so no payment can be stranded by it being wrong-but-NULL.';

-- Backfill from facts that already exist in `payouts`. Same predicate the worker
-- uses (backend/src/workers/index.ts, markSettledPayments).
UPDATE payments p
   SET settle_done_at = now()
 WHERE p.status = 'swept'
   AND p.settle_done_at IS NULL
   AND EXISTS (
     SELECT 1 FROM payouts po
      WHERE po.payment_id = p.id
        AND (
          po.status IN ('sent','confirmed','unresolved')
          OR po.broadcast_at IS NOT NULL
        )
   );

-- The settle tick's two driving queries, in their exact ORDER BY. NULLS FIRST is
-- part of the index definition on purpose — the queries say
-- `confirmed_at ASC NULLS FIRST`, and an index built with the default NULLS LAST
-- cannot supply that ordering.
CREATE INDEX IF NOT EXISTS idx_payments_settle_confirmed
  ON payments (settle_attempts, confirmed_at ASC NULLS FIRST)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_payments_settle_pending
  ON payments (settle_attempts, confirmed_at ASC NULLS FIRST)
  WHERE status = 'swept' AND settle_done_at IS NULL;

-- The anti-join the payout pass runs, and the EXISTS the marker pass runs. There
-- is no index on payouts.payment_id anywhere in the schema or the previous 17
-- migrations, so both had to hash the whole payouts table.
CREATE INDEX IF NOT EXISTS idx_payouts_payment
  ON payouts (payment_id)
  WHERE payment_id IS NOT NULL;

-- ---------- webhook_logs: redelivery -----------------------------------------
ALTER TABLE webhook_logs
  ADD COLUMN IF NOT EXISTS redelivered_at TIMESTAMPTZ;

COMMENT ON COLUMN webhook_logs.redelivered_at IS
  'When this row was re-queued for delivery after the queue had abandoned it (or '
  'never received it). Stamped by the settle tick and by operator/merchant '
  '"resend" actions, so a row cannot be re-driven again on the next tick sixty '
  'seconds later, before its own new attempt rows exist.';

-- The reaper's driving predicate.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_redeliver
  ON webhook_logs (created_at)
  WHERE success = false AND redelivered_at IS NULL AND payment_id IS NOT NULL;

-- Its "newest row of this (payment, event) group, and none of them succeeded"
-- test. idx_webhook_logs_payment is on payment_id alone and cannot serve it —
-- a merchant with a dead endpoint accumulates one row per attempt.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_group
  ON webhook_logs (payment_id, event, created_at DESC);

COMMIT;

-- Statistics for the new predicates. Cheap, and the planner needs them to prefer
-- the partial indexes over the seq scans it has been doing.
ANALYZE payments;
ANALYZE payouts;
ANALYZE webhook_logs;
