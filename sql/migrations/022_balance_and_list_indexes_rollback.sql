-- =============================================================================
-- 022 rollback — drop the covering / ordering indexes added by
--                022_balance_and_list_indexes.sql
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/022_balance_and_list_indexes_rollback.sql
--
-- SAFE AT ANY TIME. These indexes hold no data of their own and enforce nothing:
-- 022 added no column, no constraint and no uniqueness. Every query that uses
-- them returns exactly the same rows without them, just more slowly — the payout
-- balance guard falls back to a heap fetch per row (still under the advisory
-- lock) and GET /api/v1/payouts falls back to sorting the merchant's payout
-- slice. Nothing is lost and no application change is required to roll back.
--
-- idx_payouts_client_created IS NOT DROPPED HERE. It is created by BOTH 020 and
-- 022 (both IF NOT EXISTS, so applying either or both leaves exactly one index),
-- and 020 runs first, so 020 owns it. Dropping it from this file rolled back
-- part of 020 as a side effect of rolling back 022 — the same cross-migration
-- footgun that 020's own rollback carried. Roll 020 back if that index is meant
-- to go; GET /api/v1/payouts still returns identical rows without it.
--
-- On a live gateway prefer the CONCURRENTLY form, which cannot run inside a
-- transaction block — run these individually instead of this file:
--     DROP INDEX CONCURRENTLY IF EXISTS idx_payouts_bal;
--     DROP INDEX CONCURRENTLY IF EXISTS idx_payments_bal;
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_payouts_bal;
DROP INDEX IF EXISTS idx_payments_bal;

COMMIT;
