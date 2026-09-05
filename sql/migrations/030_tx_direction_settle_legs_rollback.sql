-- =============================================================================
-- 030 ROLLBACK — remove 'settle_net' / 'settle_fee' from tx_direction
--
-- PostgreSQL cannot drop an enum value, so this rebuilds the type. Only safe
-- once no row uses either value:
--
--   SELECT count(*) FROM blockchain_transactions
--    WHERE direction IN ('settle_net','settle_fee');   -- must be 0
--
-- If it is not 0, do NOT run this. Those rows are the receipts for real
-- transfers, and re-labelling them would corrupt the guard that stops a retry
-- paying a merchant twice. Set DIRECT_SETTLEMENT_ENABLED=false instead: no new
-- rows are written and the leftover values are inert.
-- =============================================================================

ALTER TYPE tx_direction RENAME TO tx_direction_old;
CREATE TYPE tx_direction AS ENUM ('incoming','sweep','payout','gas_funding');
ALTER TABLE blockchain_transactions
  ALTER COLUMN direction TYPE tx_direction USING direction::text::tx_direction;
DROP TYPE tx_direction_old;
