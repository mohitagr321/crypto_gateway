-- =============================================================================
-- 010 — Unexpected deposits (wrong-asset recovery)
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/010_unexpected_deposits.sql
-- Rollback:  sql/migrations/010_unexpected_deposits_rollback.sql
--
-- THE PROBLEM
--   A deposit address is derived per payment and expects ONE asset. Nothing on
--   chain stops a customer sending a different supported token to it — a USDC
--   transfer to a USDT payment's address is a completely valid transaction.
--
--   Until now the listeners IGNORED those: the payment stayed `waiting` and
--   expired, and the funds sat at an HD address nobody looked at. They were
--   never lost (the key is derivable — see backend/src/recover.ts) but they were
--   invisible, and recovering them required an operator running a CLI by hand.
--
--   Crediting them to the payment instead would be far worse: it would put the
--   wrong asset into a balance the merchant can withdraw, at 1:1, which is a
--   real loss the moment the two assets are not the same price.
--
-- WHAT THIS ADDS
--   A ledger of those arrivals, so they are visible and actionable. A row here
--   is NOT a balance and is deliberately not summed into one. It moves:
--       detected -> sweeping -> swept        (funds now at the central wallet)
--                            -> converting -> converted   (opt-in swap)
--                            -> failed      (needs a human)
--
-- CONVERSION IS OFF BY DEFAULT
--   `clients.auto_convert_unexpected` defaults FALSE. Converting someone's funds
--   into a different asset without asking is not a default — it realises a price
--   and a fee on their behalf. The merchant opts in per account and sets a
--   slippage ceiling.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS unexpected_deposits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- The payment whose deposit address received this. Kept for context; the
  -- payment itself is NOT credited and its own status is untouched.
  payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,

  network         TEXT NOT NULL,
  -- What actually arrived.
  asset           TEXT NOT NULL,
  amount          NUMERIC(38,18) NOT NULL,
  -- What the payment was waiting for. Recorded so the panel can say "you
  -- expected USDT, this is USDC" without re-reading the payment.
  expected_asset  TEXT,

  deposit_address TEXT NOT NULL,
  derivation_index BIGINT,
  tx_hash         TEXT NOT NULL,
  log_index       INT NOT NULL DEFAULT 0,

  status          TEXT NOT NULL DEFAULT 'detected'
                    CHECK (status IN ('detected','sweeping','swept','converting','converted','failed')),
  -- Populated once swept/converted.
  sweep_tx_hash   TEXT,
  converted_to    TEXT,
  converted_amount NUMERIC(38,18),
  swap_tx_hash    TEXT,
  error           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The same on-chain transfer must produce exactly one row, however many times
  -- the WS fast path and the polling reconciler both see it. Mirrors the
  -- UNIQUE (tx_hash, log_index) that makes blockchain_transactions idempotent.
  UNIQUE (tx_hash, log_index)
);

COMMENT ON TABLE unexpected_deposits IS
  'Known assets that arrived at a deposit address expecting a DIFFERENT asset. '
  'Not a balance and never summed into one — crediting these to the payment '
  'would put the wrong asset into a withdrawable balance at 1:1.';
COMMENT ON COLUMN unexpected_deposits.derivation_index IS
  'HD index of the receiving address. This is what makes the funds recoverable '
  'at all — the private key is derived from it (see backend/src/recover.ts).';

CREATE INDEX IF NOT EXISTS idx_unexpected_client
  ON unexpected_deposits(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unexpected_status
  ON unexpected_deposits(status) WHERE status IN ('detected','sweeping','converting');

-- ---------- merchant preferences ---------------------------------------------
-- `preferred_payout_asset` already exists (migration 008).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS auto_convert_unexpected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS max_slippage_bps INT NOT NULL DEFAULT 100;

COMMENT ON COLUMN clients.auto_convert_unexpected IS
  'Opt-in. FALSE means a wrong-asset deposit is recovered to the central wallet '
  'and left for the merchant to decide about. Converting without consent '
  'realises a price and a fee on their behalf.';
COMMENT ON COLUMN clients.max_slippage_bps IS
  'Ceiling on swap slippage, in basis points (100 = 1%). A swap quoted worse '
  'than this is abandoned rather than executed.';

DO $$
BEGIN
  ALTER TABLE clients ADD CONSTRAINT clients_slippage_check
    CHECK (max_slippage_bps BETWEEN 1 AND 5000);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- updated_at trigger -----------------------------------------------
DO $$
BEGIN
  CREATE TRIGGER trg_unexpected_deposits_updated BEFORE UPDATE ON unexpected_deposits
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
