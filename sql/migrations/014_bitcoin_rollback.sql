-- =============================================================================
-- 014 ROLLBACK — remove Bitcoin as a settlement network.
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/014_bitcoin_rollback.sql
--
-- !! READ THIS BEFORE RUNNING !!
--   Refuses while any BTC payment exists, for two reasons. A LIVE one has funds
--   at (or arriving at) a BIP-84 deposit address, and dropping the network stops
--   the listener ever crediting it. And narrowing the CHECK would fail against
--   any historical row anyway — this guard just turns a constraint-violation
--   dump into a sentence.
--
--   `payout_wallet_btc` is dropped, losing a merchant's nominated Bitcoin
--   settlement address. No money moves.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  live_btc INT := 0;
  any_btc  INT := 0;
BEGIN
  SELECT COUNT(*) INTO live_btc FROM payments
   WHERE network = 'BTC'
     AND status IN ('waiting','confirming','partial','confirmed');
  SELECT COUNT(*) INTO any_btc FROM payments WHERE network = 'BTC';

  IF live_btc > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % BTC payment(s) are still live. Funds are at or '
      'arriving at BIP-84 deposit addresses, and dropping the network stops them '
      'ever being credited. Let them settle or expire first.', live_btc;
  END IF;

  IF any_btc > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back: % historical BTC payment(s) exist. Narrowing '
      'payments_network_check would fail against them anyway. Archive or delete '
      'those rows first if you genuinely mean to remove this chain.', any_btc;
  END IF;
END $$;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_network_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_network_check
  CHECK (network IN ('BEP20','TRC20','ERC20'));

DELETE FROM chain_cursor WHERE network = 'BTC';
DELETE FROM assets WHERE network = 'BTC';

ALTER TABLE clients DROP COLUMN IF EXISTS payout_wallet_btc;

COMMIT;
