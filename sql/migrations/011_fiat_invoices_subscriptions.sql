-- =============================================================================
-- 011 — Fiat pricing, invoices, and recurring billing
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/011_fiat_invoices_subscriptions.sql
-- Rollback:  sql/migrations/011_fiat_invoices_subscriptions_rollback.sql
--
-- WHAT THIS ENABLES
--   1. A merchant prices in the money they think in — USD, INR, EUR — and the
--      customer pays in crypto. The conversion happens ONCE, at creation.
--   2. Invoices with line items, emailable, with paid/unpaid tracking.
--   3. Subscriptions that mint one invoice per billing cycle, on the existing
--      BullMQ queues.
--
-- ============================ THE RATE IS A RECORD, NOT A LOOKUP =============
--   `payments.fiat_rate` is written at creation and never recomputed. That is
--   the entire contract of fiat pricing: a customer who opens a checkout for
--   "₹5,000" and pays 25 minutes later owes the crypto amount quoted then, not
--   whatever the market has done since. Re-deriving the amount from a live rate
--   at confirmation time would mean a payment could confirm for less than it
--   was quoted for, or fail to confirm for a customer who paid exactly what
--   they were shown.
--
--   These columns are therefore an AUDIT RECORD of a decision already made, not
--   a cache to be refreshed. Nothing may ever UPDATE them on an existing row.
--
-- ============================ FIAT IS NEVER A BALANCE ========================
--   Nothing here is summed into a balance, and `fiat_amount` is not money the
--   gateway holds — it is what the merchant asked for, denominated in a currency
--   this system never custodies. The same rule that stops the ledger summing
--   across assets applies with more force here: an invoice total in INR and a
--   USDT balance are not addable quantities.
--
-- SAFETY
--   Additive. Every new payments column is nullable and NULL on every existing
--   row, which reads correctly as "priced directly in crypto" — the only way a
--   payment could be priced before this migration.
-- =============================================================================

BEGIN;

-- ---------- payments: the locked fiat quote -----------------------------------
ALTER TABLE payments
  -- ISO-4217 code the merchant priced in. NULL = priced directly in crypto.
  ADD COLUMN IF NOT EXISTS fiat_currency  TEXT,
  -- What the merchant asked for, in that currency.
  ADD COLUMN IF NOT EXISTS fiat_amount    NUMERIC(38,18),
  -- Price of ONE unit of `asset` in `fiat_currency` at the moment of creation.
  -- amount = ceil(fiat_amount / fiat_rate) at 6 dp. Kept so a dispute can be
  -- settled by arithmetic instead of by memory.
  ADD COLUMN IF NOT EXISTS fiat_rate      NUMERIC(38,18),
  -- Provenance of that rate, e.g. 'coingecko' or 'coingecko:stale'. A stale
  -- serve is legitimate (see services/rateService.ts) but it must be visible:
  -- "why is this quote 40 minutes off the market" has to be answerable.
  ADD COLUMN IF NOT EXISTS rate_source    TEXT,
  -- When the rate was FETCHED upstream, not when it was used. On a stale serve
  -- these differ, and the gap is exactly the exposure taken.
  ADD COLUMN IF NOT EXISTS rate_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN payments.fiat_rate IS
  'Price of one unit of `asset` in `fiat_currency`, frozen at creation. NEVER '
  'recomputed: the customer owes what they were quoted. An audit record, not a cache.';
COMMENT ON COLUMN payments.rate_source IS
  'Where the rate came from, including whether it was served stale. A stale '
  'quote is allowed by design but must never be silent.';

-- Either fully priced in fiat or not at all — a half-populated quote cannot be
-- audited and cannot be recomputed.
DO $$
BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_fiat_complete_check CHECK (
    (fiat_currency IS NULL AND fiat_amount IS NULL AND fiat_rate IS NULL)
    OR
    (fiat_currency IS NOT NULL AND fiat_amount > 0 AND fiat_rate > 0)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- payment_links: fiat-priced links ----------------------------------
--
-- WHY THE LINK CARRIES FIAT AND NOT A CRYPTO AMOUNT
--   An invoice for "₹5,000" is an obligation denominated in rupees. If the
--   crypto amount were fixed when the invoice was ISSUED, an invoice sitting in
--   an inbox for three days would be payable at a three-day-old price — and the
--   merchant would receive whatever that drift produced.
--
--   So a fiat-priced link stores the FIAT amount, and the conversion happens
--   when the customer starts the payment. This keeps one rule true everywhere
--   in the system, with no exceptions: THE CRYPTO AMOUNT LOCKS AT PAYMENT
--   CREATION. The customer sees a quote, the quote is frozen onto their
--   payment, and it holds for as long as that payment does.
--
--   `amount` (crypto) and `fiat_amount` are therefore mutually exclusive.
ALTER TABLE payment_links
  ADD COLUMN IF NOT EXISTS fiat_currency TEXT,
  ADD COLUMN IF NOT EXISTS fiat_amount   NUMERIC(38,18);

COMMENT ON COLUMN payment_links.fiat_amount IS
  'Price in fiat. The crypto amount is computed when the CUSTOMER starts a '
  'payment, not when the link is created — so an invoice left unpaid for days '
  'is still settled at the price current when it is actually paid.';

DO $$
BEGIN
  ALTER TABLE payment_links ADD CONSTRAINT payment_links_one_price_check CHECK (
    NOT (amount IS NOT NULL AND fiat_amount IS NOT NULL)
    AND (fiat_amount IS NULL OR (fiat_currency IS NOT NULL AND fiat_amount > 0))
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =============================================================================
-- INVOICES
-- =============================================================================
--
-- ONE CAPABILITY, NOT TWO
--   An invoice does not carry a public token of its own. It owns a single-use
--   `payment_links` row, and THAT link's token is the only thing the customer
--   ever holds — the same capability, the same rate limiters, the same public
--   surface that was already reviewed in migration 009. Minting a second public
--   token would have meant a second surface to get wrong.
--
-- THE NUMBER IS PER MERCHANT
--   Invoice numbers are sequential WITHIN a merchant (INV-0001, INV-0002 …), so
--   a merchant's books do not have holes where another merchant's invoices
--   went. A global sequence would leak the gateway's total invoice volume to
--   anyone holding two of their own invoices.

CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,                -- inv_<ulid>
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- Per-merchant sequential display number. Allocated under a row lock on the
  -- counter below, so two concurrent creates cannot mint the same number.
  number          TEXT NOT NULL,
  seq             BIGINT NOT NULL,

  -- Who it is addressed to. Free text: the gateway has no customer records, and
  -- inventing them would make invoicing depend on a CRM that does not exist.
  customer_name   TEXT,
  customer_email  TEXT,

  -- Fiat denomination of the whole document. Line items are in this currency.
  currency        TEXT NOT NULL,
  -- Sum of the line items. Stored rather than derived so a historical invoice
  -- cannot be silently restated by an edit to an item.
  subtotal        NUMERIC(38,18) NOT NULL DEFAULT 0,
  tax_amount      NUMERIC(38,18) NOT NULL DEFAULT 0,
  total           NUMERIC(38,18) NOT NULL DEFAULT 0,

  notes           TEXT,
  due_date        DATE,

  -- draft  — not yet sent, freely editable
  -- open   — issued; a pay link exists and the customer may pay
  -- paid   — its payment reached confirmed/swept/completed
  -- void   — withdrawn by the merchant; the pay link is disabled with it
  -- OVERDUE IS NOT A STATUS. It is derived from due_date at read time, so no
  -- job has to age a row and no row can be stuck in a state that a clock alone
  -- was supposed to move it out of.
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','open','paid','void')),

  -- The single-use checkout link. NULL while draft; minted on issue.
  payment_link_id UUID REFERENCES payment_links(id) ON DELETE SET NULL,
  -- The payment that actually settled it, once one has.
  payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,

  -- Which crypto asset the customer will pay in, when the merchant pins one.
  -- NULL = the customer chooses at checkout from everything the gateway settles.
  asset           TEXT,
  network         TEXT,

  -- Recurring provenance. Set when the invoice was minted by a subscription
  -- tick rather than by a human.
  subscription_id UUID,
  cycle_number    INT,

  issued_at       TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invoices_number_unique UNIQUE (client_id, seq),
  CONSTRAINT invoices_total_check CHECK (total >= 0),
  -- A subscription invoice always knows its cycle, and a manual one never has
  -- one. Half of the pair would defeat the double-bill guard below.
  CONSTRAINT invoices_cycle_pairing_check CHECK (
    (subscription_id IS NULL AND cycle_number IS NULL)
    OR (subscription_id IS NOT NULL AND cycle_number IS NOT NULL)
  )
);

COMMENT ON TABLE invoices IS
  'Merchant invoices with line items. The customer-facing capability is the '
  'token of the invoice''s single-use payment_links row — invoices mint no '
  'public token of their own.';
COMMENT ON COLUMN invoices.status IS
  'draft/open/paid/void. "Overdue" is DERIVED from due_date at read time, never '
  'stored — no job has to age a row into it.';

CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_invoices_payment ON invoices(payment_id)
  WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_link ON invoices(payment_link_id)
  WHERE payment_link_id IS NOT NULL;

-- ---------- the double-bill guard --------------------------------------------
-- THE LOAD-BEARING CONSTRAINT OF RECURRING BILLING.
--
-- The subscription tick is a repeatable job. Repeatable jobs fire twice: a
-- worker restarts mid-tick, two workers race, a retry replays. Without this
-- index a replay mints a SECOND invoice for a cycle already billed, and the
-- customer receives two demands for the same month. With it, the second insert
-- raises a unique violation the tick catches and treats as "already done".
--
-- Correctness here comes from the database, not from the worker being careful.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_subscription_cycle
  ON invoices(subscription_id, cycle_number)
  WHERE subscription_id IS NOT NULL;

-- ---------- line items --------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  -- Fractional quantities are real (2.5 hours, 0.5 kg), so this is not an INT.
  quantity     NUMERIC(38,18) NOT NULL DEFAULT 1,
  unit_price   NUMERIC(38,18) NOT NULL DEFAULT 0,
  -- quantity * unit_price, stored. Same reason as invoices.subtotal: a line's
  -- historical value must not move when arithmetic conventions change.
  amount       NUMERIC(38,18) NOT NULL DEFAULT 0,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT invoice_items_quantity_check CHECK (quantity > 0),
  CONSTRAINT invoice_items_unit_price_check CHECK (unit_price >= 0)
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice
  ON invoice_items(invoice_id, sort_order);

-- ---------- per-merchant invoice counter --------------------------------------
-- A dedicated row per merchant, incremented under UPDATE ... RETURNING inside
-- the creating transaction. A sequence would be global (leaking volume across
-- merchants) and MAX(seq)+1 would race two concurrent creates onto one number.
CREATE TABLE IF NOT EXISTS invoice_counters (
  client_id  UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  next_seq   BIGINT NOT NULL DEFAULT 1
);

COMMENT ON TABLE invoice_counters IS
  'Per-merchant invoice numbering. Incremented with UPDATE ... RETURNING inside '
  'the creating transaction, which serialises concurrent creates on the row lock.';

-- =============================================================================
-- SUBSCRIPTIONS
-- =============================================================================
--
-- BILLING DATES DO NOT DRIFT
--   `next_run_at` advances by exactly one interval from its own previous value,
--   never from now(). A worker that was down for six hours therefore bills on
--   the original date rather than moving every future cycle six hours later.
--
-- A BACKLOG IS PARKED, NOT FLUSHED
--   At most one invoice per subscription per tick. A subscription that falls
--   more than `max_cycles_behind` behind goes to 'needs_attention' instead of
--   emitting a burst of invoices into a customer's inbox. Nothing is silently
--   skipped and nothing is machine-gunned; a human decides.

CREATE TABLE IF NOT EXISTS subscriptions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  title            TEXT NOT NULL,
  description      TEXT,
  customer_name    TEXT,
  customer_email   TEXT,

  -- Price per cycle. Fiat when `currency` is a fiat code and `asset` is NULL;
  -- the rate is locked per INVOICE, so each cycle is quoted at its own date.
  currency         TEXT NOT NULL,
  amount           NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  -- Pinned settlement asset, or NULL to let the customer choose per invoice.
  asset            TEXT,
  network          TEXT,

  interval_unit    TEXT NOT NULL
                     CHECK (interval_unit IN ('day','week','month','year')),
  interval_count   INT NOT NULL DEFAULT 1
                     CHECK (interval_count BETWEEN 1 AND 366),

  -- active          — billing on schedule
  -- paused          — merchant stopped it; next_run_at is not advanced
  -- canceled        — terminal
  -- needs_attention — fell too far behind to catch up safely (see above)
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','paused','canceled','needs_attention')),

  -- When the next invoice is due to be minted. The tick selects on this.
  next_run_at      TIMESTAMPTZ NOT NULL,
  -- NULL = bill forever. Otherwise stop after this many cycles.
  total_cycles     INT CHECK (total_cycles IS NULL OR total_cycles > 0),
  cycles_billed    INT NOT NULL DEFAULT 0,

  -- How many cycles behind schedule is tolerated before parking. Per
  -- subscription so a weekly plan and an annual one can differ.
  max_cycles_behind INT NOT NULL DEFAULT 3
                     CHECK (max_cycles_behind BETWEEN 1 AND 60),

  -- Days from issue to due date on each generated invoice.
  due_days         INT NOT NULL DEFAULT 7 CHECK (due_days BETWEEN 0 AND 365),
  -- Email each generated invoice to customer_email. Requires an address.
  auto_send        BOOLEAN NOT NULL DEFAULT true,

  last_invoice_id  TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  last_run_at      TIMESTAMPTZ,
  canceled_at      TIMESTAMPTZ,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Auto-send with nowhere to send it is a configuration that silently does
  -- nothing every cycle. Refuse it at write time instead.
  CONSTRAINT subscriptions_autosend_needs_email_check
    CHECK (auto_send = false OR customer_email IS NOT NULL)
);

COMMENT ON TABLE subscriptions IS
  'Recurring billing plans. One invoice per cycle, minted by the subscription '
  'tick. next_run_at advances by one interval from its own value so billing '
  'dates never drift.';
COMMENT ON COLUMN subscriptions.next_run_at IS
  'Advanced by exactly one interval from its PREVIOUS value, never from now(), '
  'so a worker outage does not move every future billing date.';
COMMENT ON COLUMN subscriptions.max_cycles_behind IS
  'Beyond this many missed cycles the subscription parks in needs_attention '
  'rather than emitting a burst of invoices. Nothing is skipped silently.';

-- The tick's selection path: due, and still billing.
CREATE INDEX IF NOT EXISTS idx_subscriptions_due
  ON subscriptions(next_run_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_subscriptions_client
  ON subscriptions(client_id, created_at DESC);

-- Deferred FK: invoices is created before subscriptions, so the reference back
-- is added once both exist.
DO $$
BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_subscription_fkey
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- merchant default currency ----------------------------------------
-- What the panel pre-selects when pricing. Purely a default: every payment and
-- invoice records its own currency, so changing this never restates anything
-- already issued.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS default_fiat_currency TEXT;

COMMENT ON COLUMN clients.default_fiat_currency IS
  'UI default only. Every payment and invoice stores its own currency, so '
  'changing this cannot restate an existing document.';

-- ---------- updated_at triggers -----------------------------------------------
DO $$
BEGIN
  CREATE TRIGGER trg_invoices_updated BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TRIGGER trg_subscriptions_updated BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
