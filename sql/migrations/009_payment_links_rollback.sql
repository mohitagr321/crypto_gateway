-- =============================================================================
-- 009 ROLLBACK — remove hosted checkout / payment links.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/009_payment_links_rollback.sql
--
-- Use this ONLY if you are also reverting the application code to a build
-- without payment links. The added column is inert to the old code.
--
-- NOT destructive to money: payments created through a link are ordinary
-- payments and are left completely untouched. Dropping the column only removes
-- the record of HOW they were started, and `ON DELETE SET NULL` on the FK means
-- no payment row is ever removed with its link.
--
-- It does, of course, break every link already shared with a customer — those
-- URLs will 404 afterwards. Disable them in the panel first if that matters.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_payments_link;
ALTER TABLE payments DROP COLUMN IF EXISTS payment_link_id;

DROP TRIGGER IF EXISTS trg_payment_links_updated ON payment_links;
DROP INDEX IF EXISTS idx_payment_links_token_active;
DROP INDEX IF EXISTS idx_payment_links_client;
DROP TABLE IF EXISTS payment_links;

COMMIT;
