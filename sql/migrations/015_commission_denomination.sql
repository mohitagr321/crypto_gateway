-- =============================================================================
-- 015 — Give a commission a denomination
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/015_commission_denomination.sql
-- Rollback:  sql/migrations/015_commission_denomination_rollback.sql
--
-- ============================ WHAT WAS WRONG =================================
--   `commissions` held numbers that are AMOUNTS — the `fixed` value, and every
--   tier's `minAmount` / `maxAmount` / fixed `value` — with nowhere to say what
--   those amounts were amounts OF. The column comment said "fixed USDT" and the
--   service comment said "a flat USDT fee", but the code applied the number
--   verbatim to whatever asset the payment arrived in.
--
--   So a 0.04998 BTC deposit fell into a slab written as "0 – 10" (meaning ten
--   dollars), took a `fixed 1` fee meaning ONE BITCOIN, and the old clamp in
--   computeSplit cut the fee back to 100% of the gross. The merchant was never
--   paid, and because no payout row was ever created there was nothing to offset
--   the sweep — the whole deposit read as withdrawable operator commission.
--   Identical for BNB (minSweep 0.002) and ETH (minSweep 0.005).
--
--   PERCENTAGE rates were never affected: 1% of a gross is 1% whatever the gross
--   is in. They stay unscoped, which is why the signup default (a percentage,
--   inserted inline by routes/register.ts) needs no change.
--
-- ============================ WHAT THIS ADDS =================================
--   commissions.asset    the denomination of every amount in the row.
--                        NULL = no denomination, only valid for a pure rate.
--   commissions.network  optional chain restriction. NULL = every chain.
--
--   Together they let an operator express "1 USDT on BEP20" and "0.0005 BTC on
--   BTC" as two live commissions for the same client. getActiveCommission picks
--   the most specific active row for the settlement being made; computeSplit
--   REFUSES to apply an amount-denominated commission to a settlement in a
--   different asset rather than reinterpreting the number.
--
-- ============================ SAFETY / BACK-COMPAT ===========================
--   Additive and idempotent. The backfill records the meaning these rows ALREADY
--   had rather than inventing one: every fixed/tiered row becomes USDT, which is
--   what schema.sql and the service both documented. Percentage rows are left
--   NULL because they genuinely have no denomination.
--
--   FRESH INSTALLS: sql/schema.sql now carries `asset`, `network`,
--   chk_commissions_denomination and idx_commissions_client_scope directly, so a
--   new database is correct before this ever runs. Every statement here is
--   guarded (IF NOT EXISTS / duplicate_object), so re-running it against such a
--   database is a no-op — which matters, because the deploy script applies every
--   migration on every deploy under ON_ERROR_STOP=1.
-- =============================================================================

BEGIN;

-- ---------- the denomination columns -----------------------------------------
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS asset   TEXT;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS network TEXT;

COMMENT ON COLUMN commissions.asset IS
  'Denomination of every AMOUNT in this row: the fixed value and each tier''s '
  'bounds and fixed value. NULL means the row carries no amounts, which is only '
  'true of a pure percentage rate. A fixed fee is never applied to a settlement '
  'in a different asset — there is no price oracle here, and reinterpreting the '
  'number is how a one-dollar fee became one Bitcoin.';
COMMENT ON COLUMN commissions.network IS
  'Chain this commission applies to. NULL = every chain. Most specific active '
  'row wins: (network, asset), then network, then asset, then client-wide.';

-- ---------- backfill: record the meaning these rows already had ---------------
-- Not a guess. schema.sql said "percent (e.g. 1.5) or fixed USDT" and
-- commissionService's own interface said "fixed USDT fee", so a fixed or tiered
-- row that exists today IS denominated in USDT. Writing that down changes no
-- USDT settlement and makes every non-USDT settlement fail loudly instead of
-- charging 100%.
UPDATE commissions
   SET asset = 'USDT'
 WHERE asset IS NULL
   AND type IN ('fixed', 'tiered');

-- Percentage rows are deliberately left NULL: a rate has no denomination, and
-- pinning one would stop it applying to the other assets it correctly covers.

-- ---------- an amount-denominated commission must say what it is in ----------
DO $$
BEGIN
  ALTER TABLE commissions
    ADD CONSTRAINT chk_commissions_denomination
    CHECK (type = 'percentage' OR asset IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------- scoped lookup ----------------------------------------------------
-- getActiveCommission filters on (client_id, network, asset) among active rows.
-- The pre-existing idx_commissions_client_active stays: it still serves the
-- unscoped read that callers not yet threaded with an asset make.
CREATE INDEX IF NOT EXISTS idx_commissions_client_scope
  ON commissions(client_id, network, asset) WHERE is_active;

-- ---------- indexes for the per-asset admin commission balance ---------------
-- getCommissionBalance / getAllCommissionBalances now aggregate per
-- (network, asset) across three tables on every admin dashboard load. The sweep
-- aggregate is the expensive one — blockchain_transactions is the largest table
-- here and idx_btx_network_asset does not cover the direction/status predicate.
CREATE INDEX IF NOT EXISTS idx_btx_sweep_network_asset
  ON blockchain_transactions(network, asset)
  WHERE direction = 'sweep' AND status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_payouts_network_asset_status
  ON payouts(network, asset, status);

CREATE INDEX IF NOT EXISTS idx_admin_withdrawals_network_asset_status
  ON admin_withdrawals(network, asset, status);

-- ---------- withdrawals name their asset -------------------------------------
-- The column has existed since 008 with a 'USDT' default, and
-- requestAdminWithdrawal never set it, so the column says USDT on every row
-- written before this migration. On BEP20/TRC20/ERC20 that is also what actually
-- went on the wire (chainBroadcast fell back to the chain default, which is USDT
-- there), so those rows need nothing.
--
-- BITCOIN IS THE EXCEPTION AND IT IS A MONEY BUG. defaultAssetFor('BTC') is BTC,
-- so a pre-015 withdrawal on the BTC chain BROADCAST BITCOIN while its row still
-- read 'USDT'. Once getCommissionBalance filters on asset, that row stops being
-- subtracted from the BTC pool: `withdrawn` drops to zero, `available` reports
-- Bitcoin that has already left the central wallet, and an operator can withdraw
-- the same commission a second time — out of merchants' BTC deposits. Write down
-- what was actually sent.
--
-- Unconditionally safe, and idempotent: after 015 the code resolves the asset
-- through parseAsset(network, ...), which rejects USDT on BTC outright, so a
-- (network='BTC', asset='USDT') row can only ever be a pre-015 row.
UPDATE admin_withdrawals
   SET asset = 'BTC'
 WHERE network = 'BTC'
   AND asset = 'USDT';

COMMENT ON COLUMN admin_withdrawals.asset IS
  'Asset withdrawn from the central wallet. Written explicitly since 015 and '
  'threaded into the broadcast — the commission pool is per (network, asset) '
  'and a BNB accrual is not spendable as USDT.';

COMMIT;
