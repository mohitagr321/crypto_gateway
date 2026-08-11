-- =============================================================================
-- 016 — `unresolved`: a payout whose transaction may already be on the wire
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/016_payout_unresolved.sql
-- Rollback:  sql/migrations/016_payout_unresolved_rollback.sql
--
-- THE PROBLEM
--   executePayout caught ANY throw out of the broadcast and wrote `failed`. But
--   a throw does not mean nothing was sent — a socket reset after the node
--   accepted the transaction throws, and so does a Tron send whose response was
--   lost. `failed` is not a neutral label here: it is a RELEASE. Every predicate
--   that reserves a merchant's balance lists the live statuses and omits
--   `failed`, so the moment a broadcast payout was marked failed:
--
--     * its gross dropped out of `paidOut` and the balance became spendable
--       again (services/payoutService.ts, getBalanceWith / getAllBalances), and
--     * the settle tick's `NOT EXISTS (... status IN (...))` guard stopped
--       seeing a payout for that payment (workers/index.ts) and created a
--       SECOND one, with a fresh nonce, for the same money.
--
--   The per-row protections in services/chainBroadcast.ts cannot help there:
--   they are keyed on THAT row's `broadcast_at`/`signed_tx`, and the second row
--   has neither. Both transactions land. The merchant is paid twice out of the
--   central hot wallet, and `available` is clamped at 0 so the overdraft is
--   invisible.
--
-- THE STATE
--   `unresolved` means: we broadcast, and we do not know whether it landed. It
--   is a LIVE status — it holds the reservation exactly like `sent` — and it is
--   terminal for automation. Only a human, having checked the explorer, may move
--   it on: to `sent`/`confirmed` if the transaction is there, or to `failed`
--   (which releases the funds) if it demonstrably is not.
--
--   The distinction that decides it is `broadcast_at`. It is stamped before
--   anything reaches the wire — by `markAttempted` on chains that cannot
--   pre-sign, and by `persistPrepared` on chains that can. NULL therefore means
--   we know nothing was sent; NOT NULL means we do not know. Unknown is treated
--   as in-flight, because releasing on unknown is how the same money gets sent
--   twice.
--
-- THE INDEX
--   Belt and braces, in the same spirit as uq_invoices_subscription_cycle: even
--   if some future predicate forgets a status, the database will not accept a
--   second live payout for a payment that already has one. `failed` is excluded
--   because a payout that provably never reached the wire is meant to be
--   retried by creating a fresh row.
--
-- !! THIS MIGRATION MAY REFUSE TO APPLY !!
--   The unique index is created against existing data. If this deployment has
--   already produced duplicate live payouts for one payment — which is the very
--   bug above — the CREATE will fail and name the payment. That is deliberate:
--   reconcile those rows against the explorer by hand (mark the ones that never
--   landed `failed`) and re-run. Do not drop the index to get past it.
--
-- SAFETY
--   Additive. `ALTER TYPE ... ADD VALUE` cannot remove or reorder anything, and
--   no existing row acquires the new status. Nothing writes `unresolved` until
--   the backend carrying services/payoutService.ts is deployed, so this may be
--   applied ahead of the release. It MUST NOT be applied after it: the backend's
--   failure path casts to the enum value and will error without it (safely — the
--   row stays `processing`, which is still reserved — but noisily).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The enum value. Intentionally OUTSIDE the transaction below: on PostgreSQL
--    before 12 `ALTER TYPE ... ADD VALUE` cannot run in a transaction block at
--    all, and even on 12+ the new value is not usable until its transaction
--    commits. Keeping it standalone works on every version.
-- ---------------------------------------------------------------------------
ALTER TYPE payout_status ADD VALUE IF NOT EXISTS 'unresolved';

BEGIN;

-- One live payout per payment, enforced by the database.
--
-- `payment_id IS NOT NULL` keeps manual payouts (which carry no payment) out of
-- it entirely — a merchant may have any number of those.
--
-- IF NOT EXISTS because the deploy script re-runs every migration on every
-- deploy under ON_ERROR_STOP=1 and aborts the deploy on any error — a bare
-- CREATE INDEX would fail the SECOND deploy, and fail immediately on a fresh
-- install now that sql/schema.sql carries this index too. It does NOT weaken the
-- duplicate check below: IF NOT EXISTS only skips when an index of this NAME
-- already exists, so a first creation against duplicate data still fails loudly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_active_payment
  ON payouts(payment_id)
  WHERE payment_id IS NOT NULL AND status <> 'failed';

COMMENT ON INDEX uq_payouts_active_payment IS
  'One live payout per payment. The settle tick recreates a payout when it sees '
  'none in a live status; this stops a released-too-early row from becoming a '
  'second on-chain transfer. A 23505 here is a no-op for the caller, not a fault.';

-- Makes the operator queue ("what is stuck and needs a human?") an index scan
-- rather than a sequential one. idx_payouts_status covers equality on status,
-- but this keeps the two states an operator actually works ordered by age.
CREATE INDEX IF NOT EXISTS idx_payouts_needs_operator
  ON payouts(created_at)
  WHERE status IN ('unresolved', 'processing');

COMMIT;
