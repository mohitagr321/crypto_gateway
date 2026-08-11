-- 019_hd_index_sequence.sql
--
-- Replace the single-row `hd_counter` allocator with a real Postgres SEQUENCE.
--
-- WHY
-- ---
-- `UPDATE hd_counter SET next_index = next_index + 1 WHERE id = 1 RETURNING ...`
-- was called with the payment-creation transaction's own client. Postgres holds
-- row locks until COMMIT (not for the duration of the statement, as the old
-- docstring claimed), so that one row was locked across a ~3.4 ms synchronous
-- key derivation, the wallets INSERT, the payments INSERT and the WAL commit.
-- Every payment creation in every API replica queued behind it, capping the
-- product at roughly 100-200 creations/second no matter how many replicas ran.
--
-- `nextval()` takes no transactional lock and never blocks a concurrent caller.
--
-- GAPS
-- ----
-- A sequence does not roll back, so a failed creation burns its index. That is
-- fine here and always was: HD indexes are never reused, and a skipped index is
-- simply a deposit address that was never shown to anyone. Nothing in the
-- codebase iterates indexes densely — they are read back per-wallet (the sweep
-- worker, routes/account.ts, unexpected_deposits) or passed by hand to
-- src/recover.ts. `idx_wallets_deriv` (UNIQUE derivation_index WHERE
-- type = 'deposit') remains the uniqueness backstop either way.
--
-- CUTOVER SAFETY
-- --------------
-- The seed is `max(hd_counter.next_index, max(derivation_index) + 1) + 1000000`.
--
-- The margin exists because OLD code — any replica that has not yet restarted —
-- keeps allocating out of `hd_counter`, which this migration does not touch and
-- deliberately does not drop. Both allocators are therefore live for the whole
-- of a rolling restart, and the margin is the only thing keeping their ranges
-- disjoint. `deploy-crypto-gateway.sh` applies every migration BEFORE restarting
-- the processes (docs/deployment.md §7b), so that window is minutes, not
-- milliseconds — and the old allocator ran at up to ~200 creations/second, so a
-- margin of 1000 would have been consumed in ~5 seconds. It has to cover the
-- deploy, not just an in-flight statement.
--
-- Overrunning the margin would NOT put two payments on one deposit address:
-- `idx_wallets_deriv` (UNIQUE derivation_index WHERE type = 'deposit') turns the
-- overlap into a 23505 that rolls the whole creation back. It would be a payment
-- creation OUTAGE, which is why the margin is sized for the deploy window.
--
-- 1,000,000 burned indexes cost nothing: they are addresses nobody was ever
-- shown, and the usable range is 0..2^31-1 (utils/hdwallet.ts caps there because
-- a hardened child could never be swept).
--
-- ORDERING: the application is forward-compatible — utils/hdwallet.ts falls back
-- to the `hd_counter` UPDATE on 42P01 — so this migration may be applied either
-- BEFORE or AFTER the code ships. Applying it AFTER every replica is running the
-- new code is strictly safer: no old allocator exists at that point and the
-- margin only has to cover an in-flight statement.
--
-- `hd_counter` is deliberately NOT dropped. It is the seed of record, it is the
-- fallback the application still uses if this migration has not been applied
-- (utils/hdwallet.ts), and the rollback below needs it.
--
-- Idempotent: re-running is a no-op, never a reseed. Reseeding an existing
-- sequence backwards would re-issue live indexes.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S'
       AND c.relname = 'hd_deposit_index'
       AND n.nspname = current_schema()
  ) THEN
    EXECUTE 'CREATE SEQUENCE hd_deposit_index AS BIGINT MINVALUE 0 START WITH 0';

    PERFORM setval(
      'hd_deposit_index',
      GREATEST(
        COALESCE((SELECT next_index FROM hd_counter WHERE id = 1), 0),
        COALESCE((SELECT MAX(derivation_index) + 1 FROM wallets WHERE type = 'deposit'), 0)
      ) + 1000000,   -- see CUTOVER SAFETY: sized for a rolling restart, not a statement
      false   -- is_called = false: the NEXT nextval() returns exactly this value
    );
  END IF;
END
$$;

COMMENT ON SEQUENCE hd_deposit_index IS
  'Monotonic BIP-44 child index for deposit addresses, shared by every network '
  '(BEP20 m/44''/60''/0''/0/<i>, TRC20 m/44''/195''/0''/0/<i>, BTC likewise), so '
  'an index is never reused across chains. Gaps are expected and harmless. '
  'Replaces hd_counter, which is kept only as the seed of record.';

COMMENT ON TABLE hd_counter IS
  'LEGACY as of migration 019 — superseded by the hd_deposit_index sequence. '
  'Kept as the seed of record and as the application''s pre-migration fallback. '
  'Do not resume writing to it while the sequence exists.';
