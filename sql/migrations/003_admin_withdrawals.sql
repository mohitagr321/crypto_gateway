-- Migration: admin commission withdrawals.
-- The central wallet retains commission (swept gross minus client net payouts).
-- This table records the admin withdrawing that accrued commission to a wallet.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS admin_withdrawals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount        NUMERIC(38,18) NOT NULL,
  to_address    TEXT NOT NULL,
  tx_hash       TEXT,
  status        payout_status NOT NULL DEFAULT 'pending',  -- pending|processing|sent|confirmed|failed
  triggered_by  UUID REFERENCES users(id),
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_withdrawals_status ON admin_withdrawals(status);
