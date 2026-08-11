-- =============================================================================
-- Rollback for 021_link_use_semantics_comment.sql
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/021_link_use_semantics_comment_rollback.sql
--
-- Restores the previous comment text. Documentation only — nothing else in the
-- database is touched, and no application behaviour depends on this.
-- =============================================================================

BEGIN;

COMMENT ON COLUMN payment_links.use_count IS
  'Incremented in the SAME transaction that creates a payment, under a row lock, '
  'so a single-use link cannot be spent twice by concurrent opens.';

COMMIT;
