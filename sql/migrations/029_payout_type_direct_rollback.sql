-- =============================================================================
-- 029 ROLLBACK — remove 'direct' from payout_type
--
-- PostgreSQL has no DROP VALUE for an enum. Reversing 029 means rebuilding the
-- type, and that is only safe once NO row uses the value:
--
--   SELECT count(*) FROM payouts WHERE type = 'direct';   -- must be 0
--
-- If that count is non-zero, do NOT run this: those rows are real settlements
-- and re-labelling them 'auto' would assert that the money left the central
-- wallet, which it did not. Turn DIRECT_SETTLEMENT_ENABLED off instead — no new
-- 'direct' rows are written, and the leftover value is inert.
--
-- With the count at zero:
-- =============================================================================

ALTER TYPE payout_type RENAME TO payout_type_old;
CREATE TYPE payout_type AS ENUM ('auto','manual');
ALTER TABLE payouts
  ALTER COLUMN type DROP DEFAULT,
  ALTER COLUMN type TYPE payout_type USING type::text::payout_type,
  ALTER COLUMN type SET DEFAULT 'auto';
DROP TYPE payout_type_old;
