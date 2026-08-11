-- =============================================================================
-- 021 — payment_links.use_count now means "uses that were actually taken"
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/021_link_use_semantics_comment.sql
-- Rollback:  sql/migrations/021_link_use_semantics_comment_rollback.sql
--
-- DOCUMENTATION ONLY. No column, no index, no constraint, no data. It exists
-- because the comment already on this column describes behaviour the code no
-- longer has, and a wrong comment on a live database is worse than none.
--
-- WHAT CHANGED IN THE CODE (backend/src/services/paymentLinkService.ts)
--   use_count used to be incremented the instant a payment was CREATED, and
--   decremented by nothing anywhere. So a customer who opened a hosted checkout
--   and never paid burned the link permanently. Every invoice mints a
--   max_uses = 1 link, so one abandoned checkout made that invoice unpayable
--   forever.
--
--   claimLinkUse now DERIVES the count from the payments the link produced:
--
--       consumed = count(payments WHERE payment_link_id = l.id
--                        AND NOT (status IN ('expired','failed')
--                                 AND amount_received = 0))
--
--   and writes that derived value (plus the use being claimed) back onto
--   use_count under the link's row lock. Only a payment that is dead AND never
--   received anything releases its use; anything live, confirmed, swept, or
--   dead-but-funded holds it forever, so a link still cannot be paid twice.
--
--   Nothing needs backfilling. The derived count is recomputed on every claim
--   and on every read of the link, so an existing row carrying an inflated
--   use_count self-corrects the next time the link is opened or claimed — and
--   in the meantime the CHECKS no longer read that column at all.
-- =============================================================================

BEGIN;

COMMENT ON COLUMN payment_links.use_count IS
  'Uses actually TAKEN, derived from this link''s payments and reconciled onto '
  'the row inside the claim transaction, under the link''s row lock — so a '
  'single-use link still cannot be claimed twice by concurrent opens. A payment '
  'that expired or failed having received nothing does NOT count: an abandoned '
  'checkout must not burn the link. Anything live, or that ever received funds, '
  'counts permanently.';

COMMIT;
