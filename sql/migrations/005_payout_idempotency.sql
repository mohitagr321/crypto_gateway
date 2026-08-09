-- =============================================================================
-- 005 — Make outbound transfers idempotent (payouts + admin withdrawals)
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/005_payout_idempotency.sql
--
-- THE BUG THIS CLOSES
--   executePayout broadcast a transfer, and on ANY thrown error marked the row
--   `failed` and let BullMQ retry it. But a throw does not mean the transfer
--   failed — an RPC connection dropped after the node accepted the transaction
--   throws too, and so does a confirmation-wait timeout. The retry then signed a
--   SECOND transfer and the merchant was paid twice.
--
--   The fix is to pin the transaction before broadcasting: pick the nonce, sign,
--   store the signed bytes and their hash, and only then send. A retry
--   re-broadcasts the SAME signed bytes, which is a no-op on-chain because it is
--   the same transaction. Even a re-sign could not double-pay, because the nonce
--   is fixed and a chain mines at most one transaction per nonce.
--
-- SAFETY / BACK-COMPAT
--   Additive and idempotent. Existing rows get NULLs, which read as "never
--   prepared" — the exact state a fresh payout is in, so in-flight rows behave
--   correctly across the deploy.
-- =============================================================================

BEGIN;

-- ---------- payouts ----------------------------------------------------------
-- nonce      : the EVM account nonce this payout is pinned to. NULL on chains
--              that have no nonce (Tron) and on rows created before this
--              migration.
-- signed_tx  : the raw signed transaction, hex. Re-broadcasting it is a no-op
--              once mined, which is what makes the retry safe. Public data —
--              it is exactly what was already put on the wire.
-- broadcast_at: set the moment a broadcast is ATTEMPTED, before we know whether
--              it succeeded. This is the flag that says "a transaction may exist
--              on-chain for this row" — the one thing a retry must never ignore.
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS nonce        BIGINT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS signed_tx    TEXT;
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS broadcast_at TIMESTAMPTZ;

COMMENT ON COLUMN payouts.nonce IS
  'EVM account nonce this payout is pinned to; NULL on nonce-less chains. A '
  'chain mines at most one transaction per nonce, so a retry cannot double-pay.';
COMMENT ON COLUMN payouts.signed_tx IS
  'Raw signed transaction hex. A retry re-broadcasts these exact bytes rather '
  'than signing a new transfer.';
COMMENT ON COLUMN payouts.broadcast_at IS
  'When a broadcast was first ATTEMPTED. Non-null means a transaction may exist '
  'on-chain even if the row says failed — never blind-retry such a row.';

-- ---------- admin_withdrawals ------------------------------------------------
-- Same signing key, same central wallet, same failure mode.
ALTER TABLE admin_withdrawals ADD COLUMN IF NOT EXISTS nonce        BIGINT;
ALTER TABLE admin_withdrawals ADD COLUMN IF NOT EXISTS signed_tx    TEXT;
ALTER TABLE admin_withdrawals ADD COLUMN IF NOT EXISTS broadcast_at TIMESTAMPTZ;

-- ---------- payout balance guard --------------------------------------------
-- requestPayout reads a client's available balance and then inserts a payout.
-- Nothing serialised the two, so two concurrent requests could both pass the
-- guard against the same balance and together overdraw it. The service now
-- takes a transaction-scoped advisory lock keyed on the client before reading;
-- this index is what keeps the read it does under that lock cheap.
CREATE INDEX IF NOT EXISTS idx_payouts_client_network_status
  ON payouts(client_id, network, status);
CREATE INDEX IF NOT EXISTS idx_payments_client_network_status
  ON payments(client_id, network, status);

COMMIT;
