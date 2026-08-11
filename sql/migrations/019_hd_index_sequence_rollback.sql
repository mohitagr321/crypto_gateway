-- 019_hd_index_sequence_rollback.sql
--
-- Undo 018 by handing allocation back to the hd_counter row.
--
-- ORDER MATTERS. The sequence has been issuing indexes that hd_counter knows
-- nothing about, so hd_counter MUST be fast-forwarded past them BEFORE the
-- sequence is dropped. Dropping first would leave the counter stale, the next
-- creations would re-issue live derivation indexes, and every one of them would
-- fail on idx_wallets_deriv (23505) — payment creation down until someone
-- noticed. The unique index means this is a hard failure, never two payments
-- quietly sharing a deposit address, but it is still an outage.
--
-- The margin below covers an allocation that is in flight while this runs. It
-- only has to cover a statement, not a deploy: once the sequence is gone every
-- replica — old code and new alike — allocates from hd_counter, so unlike the
-- forward migration there is no second live allocator to stay clear of. It is
-- kept at 1,000,000 to match the forward migration anyway; the indexes cost
-- nothing and matching the two numbers makes a re-apply/rollback cycle trivial
-- to reason about.

DO $$
DECLARE
  high_water BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S'
       AND c.relname = 'hd_deposit_index'
       AND n.nspname = current_schema()
  ) THEN
    SELECT GREATEST(
             -- last_value is the seed itself when nextval() has never run
             (SELECT last_value FROM hd_deposit_index) + 1,
             COALESCE((SELECT MAX(derivation_index) + 1 FROM wallets WHERE type = 'deposit'), 0)
           ) + 1000000
      INTO high_water;

    UPDATE hd_counter
       SET next_index = GREATEST(next_index, high_water)
     WHERE id = 1;

    DROP SEQUENCE hd_deposit_index;
  END IF;
END
$$;

COMMENT ON TABLE hd_counter IS
  'Monotonic counter for HD derivation indexes (avoids reuse / races). Shared by '
  'BOTH networks: BEP20 derives at m/44''/60''/0''/0/<i> and TRC20 at '
  'm/44''/195''/0''/0/<i>, so the same <i> yields two unrelated, disjoint keys.';
