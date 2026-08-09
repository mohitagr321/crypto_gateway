-- =============================================================================
-- 011 ROLLBACK — remove fiat pricing, invoices, and recurring billing.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/011_fiat_invoices_subscriptions_rollback.sql
--
-- !! READ THIS BEFORE RUNNING !!
--
--   1. DROPPING THE FIAT COLUMNS DESTROYS EVIDENCE, NOT MONEY.
--      Every payment keeps its crypto `amount`, which is what was actually
--      owed and actually paid — no balance moves and no settlement changes.
--      What is lost is the RECORD OF WHY that amount was chosen: the currency
--      the merchant priced in, the rate, and when it was locked. After this
--      runs, a customer disputing "I was quoted ₹5,000" cannot be answered by
--      arithmetic any more. Export the columns first if any fiat-priced payment
--      exists.
--
--   2. IT REFUSES TO RUN WHILE MONEY IS EXPECTED.
--      An open invoice is an outstanding demand a customer may be about to pay,
--      and an active subscription is a promise to bill again. Dropping either
--      would leave a live payment link with nothing behind it: the customer
--      still pays, and no invoice is ever marked settled. Void or settle the
--      open invoices and cancel the active subscriptions first.
--
--   Paid and void invoices are safe to discard — their payments stand on their
--   own and keep their own records.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  open_invoices INT := 0;
  live_subs     INT := 0;
  fiat_payments INT := 0;
BEGIN
  IF to_regclass('invoices') IS NOT NULL THEN
    SELECT COUNT(*) INTO open_invoices FROM invoices WHERE status = 'open';
  END IF;
  IF to_regclass('subscriptions') IS NOT NULL THEN
    SELECT COUNT(*) INTO live_subs FROM subscriptions
     WHERE status IN ('active','paused','needs_attention');
  END IF;

  IF open_invoices > 0 OR live_subs > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % open invoice(s) and % live subscription(s). '
      'An open invoice has a LIVE payment link a customer may pay at any '
      'moment — drop the table and that payment arrives with nothing to settle '
      'against. Void or settle the invoices and cancel the subscriptions first.',
      open_invoices, live_subs;
  END IF;

  -- Not fatal, but the operator should know what is about to be erased.
  SELECT COUNT(*) INTO fiat_payments FROM payments WHERE fiat_currency IS NOT NULL;
  IF fiat_payments > 0 THEN
    RAISE WARNING
      '% payment(s) were priced in fiat. Their currency, rate and lock time are '
      'about to be dropped; the crypto amounts and all settlement are '
      'unaffected, but the quote can no longer be reconstructed.', fiat_payments;
  END IF;
END $$;

-- ---------- subscriptions ------------------------------------------------------
ALTER TABLE IF EXISTS invoices DROP CONSTRAINT IF EXISTS invoices_subscription_fkey;

DROP TRIGGER IF EXISTS trg_subscriptions_updated ON subscriptions;
DROP INDEX IF EXISTS idx_subscriptions_client;
DROP INDEX IF EXISTS idx_subscriptions_due;
DROP TABLE IF EXISTS subscriptions;

-- ---------- invoices -----------------------------------------------------------
DROP TRIGGER IF EXISTS trg_invoices_updated ON invoices;
DROP INDEX IF EXISTS idx_invoice_items_invoice;
DROP TABLE IF EXISTS invoice_items;

DROP INDEX IF EXISTS uq_invoices_subscription_cycle;
DROP INDEX IF EXISTS idx_invoices_link;
DROP INDEX IF EXISTS idx_invoices_payment;
DROP INDEX IF EXISTS idx_invoices_status;
DROP INDEX IF EXISTS idx_invoices_client;
DROP TABLE IF EXISTS invoices;

DROP TABLE IF EXISTS invoice_counters;

-- ---------- clients ------------------------------------------------------------
ALTER TABLE clients DROP COLUMN IF EXISTS default_fiat_currency;

-- ---------- payment_links ------------------------------------------------------
-- Guarded above: this only runs once no invoice is open. A standalone
-- fiat-priced link (one not backed by an invoice) becomes unpayable rather than
-- mispriced — the price is gone, so the checkout refuses instead of quoting a
-- number it made up.
ALTER TABLE payment_links DROP CONSTRAINT IF EXISTS payment_links_one_price_check;
ALTER TABLE payment_links
  DROP COLUMN IF EXISTS fiat_amount,
  DROP COLUMN IF EXISTS fiat_currency;

-- ---------- payments -----------------------------------------------------------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_fiat_complete_check;
ALTER TABLE payments
  DROP COLUMN IF EXISTS rate_locked_at,
  DROP COLUMN IF EXISTS rate_source,
  DROP COLUMN IF EXISTS fiat_rate,
  DROP COLUMN IF EXISTS fiat_amount,
  DROP COLUMN IF EXISTS fiat_currency;

COMMIT;
