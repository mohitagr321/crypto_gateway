-- =============================================================================
-- 009 — Payment links (hosted checkout)
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/009_payment_links.sql
-- Rollback:  sql/migrations/009_payment_links_rollback.sql
--
-- WHAT THIS ENABLES
--   A shareable URL a merchant can send to a customer. The customer opens it,
--   picks a coin, and pays — no integration, no API key, no code. This is the
--   feature that makes the gateway usable by a merchant who cannot write a
--   server, and it is the most-used surface on comparable gateways.
--
-- THE TOKEN IS A CAPABILITY
--   `token` appears in a URL that gets pasted into chats and emails. Anyone
--   holding it can open the checkout, so it is generated with full entropy and
--   is the ONLY thing the public endpoints accept. It deliberately grants the
--   ability to *pay*, and nothing else: the public API exposes the business
--   name and the amount, never the merchant's id, email, wallet or balance.
--
-- SAFETY
--   Additive. `payments.payment_link_id` is nullable and NULL for every existing
--   row, which reads correctly as "created through the API, not a link".
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payment_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- Public slug in the checkout URL. High-entropy: it is the only credential
  -- the public endpoints see.
  token         TEXT UNIQUE NOT NULL,

  title         TEXT NOT NULL,
  description   TEXT,

  -- NULL amount = the customer types one (donations, top-ups). A fixed amount
  -- is the common case and is what the checkout locks in.
  amount        NUMERIC(38,18),
  -- NULL asset/network = the customer chooses from what the gateway settles.
  -- Pinning them is how a merchant says "pay me in USDC on BEP20, specifically".
  asset         TEXT,
  network       TEXT,

  -- A reusable link can spawn many payments (a product page). A single-use link
  -- is an invoice: one customer, one payment.
  reusable      BOOLEAN NOT NULL DEFAULT true,
  -- NULL = unlimited. Enforced against `use_count` at payment-creation time,
  -- inside the same transaction that increments it, so concurrent opens cannot
  -- both slip past the last remaining use.
  max_uses      INT,
  use_count     INT NOT NULL DEFAULT 0,

  expires_at    TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','disabled')),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A fixed amount must be positive; an open amount is expressed as NULL, never
  -- as zero (which would render as a "pay 0.00" checkout).
  CONSTRAINT payment_links_amount_check CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT payment_links_max_uses_check CHECK (max_uses IS NULL OR max_uses > 0)
);

COMMENT ON TABLE payment_links IS
  'Shareable hosted-checkout URLs. `token` is a capability: holding it allows '
  'paying, and nothing else — no merchant identity or balance is ever exposed.';
COMMENT ON COLUMN payment_links.amount IS
  'NULL = customer enters the amount. Never zero.';
COMMENT ON COLUMN payment_links.use_count IS
  'Incremented in the SAME transaction that creates a payment, under a row lock, '
  'so a single-use link cannot be spent twice by concurrent opens.';

CREATE INDEX IF NOT EXISTS idx_payment_links_client
  ON payment_links(client_id, created_at DESC);
-- The public lookup path: by token, and only while usable.
CREATE INDEX IF NOT EXISTS idx_payment_links_token_active
  ON payment_links(token) WHERE status = 'active';

-- ---------- payments -> link provenance --------------------------------------
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_link_id UUID REFERENCES payment_links(id) ON DELETE SET NULL;

COMMENT ON COLUMN payments.payment_link_id IS
  'Set when the payment was started from a hosted checkout link. NULL means it '
  'was created through the API. Also the authorisation for the PUBLIC status '
  'endpoint: only link-created payments are readable without credentials.';

CREATE INDEX IF NOT EXISTS idx_payments_link ON payments(payment_link_id)
  WHERE payment_link_id IS NOT NULL;

-- ---------- updated_at trigger -----------------------------------------------
DO $$
BEGIN
  CREATE TRIGGER trg_payment_links_updated BEFORE UPDATE ON payment_links
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
