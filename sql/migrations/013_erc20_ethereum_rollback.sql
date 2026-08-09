-- =============================================================================
-- 013 ROLLBACK — remove Ethereum as a settlement network.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/013_erc20_ethereum_rollback.sql
--
-- !! READ THIS BEFORE RUNNING !!
--   Narrowing `payments.network` back to (BEP20, TRC20) is only possible if no
--   ERC20 payment exists — Postgres validates a CHECK against every row, so
--   this fails loudly rather than corrupting anything. That is the desired
--   behaviour, but it means the guard below exists to give a USEFUL error
--   instead of a constraint-violation dump.
--
--   It refuses while any ERC20 payment is live for the stronger reason: those
--   have funds at, or arriving at, HD deposit addresses. Dropping the network
--   stops the listener from ever crediting them.
--
--   `payout_wallet_erc20` is dropped, which loses a merchant's nominated
--   Ethereum settlement address. It does not move money.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  live_erc20 INT := 0;
  any_erc20  INT := 0;
BEGIN
  SELECT COUNT(*) INTO live_erc20 FROM payments
   WHERE network = 'ERC20'
     AND status IN ('waiting','confirming','partial','confirmed');
  SELECT COUNT(*) INTO any_erc20 FROM payments WHERE network = 'ERC20';

  IF live_erc20 > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % ERC20 payment(s) are still live. Funds are at '
      'or arriving at HD deposit addresses, and dropping the network stops them '
      'ever being credited. Let them settle or expire first.', live_erc20;
  END IF;

  IF any_erc20 > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % historical ERC20 payment(s) exist. Narrowing '
      'payments_network_check would fail against them anyway. Archive or delete '
      'those rows first if you genuinely mean to remove this chain.', any_erc20;
  END IF;
END $$;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_network_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_network_check
  CHECK (network IN ('BEP20','TRC20'));

DELETE FROM chain_cursor WHERE network IN ('ERC20', 'ERC20_NATIVE');
DELETE FROM assets WHERE network = 'ERC20';

ALTER TABLE clients DROP COLUMN IF EXISTS payout_wallet_erc20;

COMMIT;
