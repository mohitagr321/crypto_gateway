-- =============================================================================
-- 031 ROLLBACK — remove 'settle_hop' from tx_direction
--
-- Only safe once nothing uses it:
--   SELECT count(*) FROM blockchain_transactions WHERE direction = 'settle_hop';
--
-- Non-zero means real transfers are recorded with it; set
-- SETTLEMENT_INTERMEDIATE_ENABLED=false instead and leave the value in place.
-- Rebuilding the type must also keep 029/030's values or those rows break.
-- =============================================================================

ALTER TYPE tx_direction RENAME TO tx_direction_old;
CREATE TYPE tx_direction AS ENUM
  ('incoming','sweep','payout','gas_funding','settle_net','settle_fee');
ALTER TABLE blockchain_transactions
  ALTER COLUMN direction TYPE tx_direction USING direction::text::tx_direction;
DROP TYPE tx_direction_old;
