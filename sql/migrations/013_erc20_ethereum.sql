-- =============================================================================
-- 013 — ERC20 (Ethereum) as a settlement network
--
-- Run with: psql "$DATABASE_URL" -f sql/migrations/013_erc20_ethereum.sql
-- Rollback:  sql/migrations/013_erc20_ethereum_rollback.sql
--
-- WHY 013 AND NOT 006
--   `006` was held open for the unmerged `feat/erc20-multi-network` branch to
--   renumber its colliding `005` into. That branch is NOT being merged: it
--   forked before multi-asset, and its EVM listener has no concept of an asset,
--   so taking it would drop the clause that stops a USDC transfer being credited
--   1:1 against a USDT payment. Its good ideas (a per-chain EVM config, a gas
--   policy that DEFERS a sweep when fees spike) were reimplemented on top of the
--   current code instead. **`006` is therefore free for good** — nothing is
--   waiting for it any more.
--
-- ============================ ETHEREUM IS NOT "BSC BUT SLOWER" ===============
--   Two differences have real consequences, and both are handled in code rather
--   than here:
--
--   1. USDT and USDC on Ethereum are 6 dp. On BSC they are 18. A single shared
--      decimals constant would mis-scale every Ethereum amount by 10^12 — which
--      is why decimals live per-ASSET in backend/src/blockchain/assets.ts and
--      never per-chain.
--
--   2. Gas is expensive and volatile. A sweep that costs more than it moves is
--      deferred, not failed — see the dynamic gas policy in evmChains.ts.
--
--   3. Ethereum and BSC share BIP-44 coin type 60, so HD index N derives the
--      SAME address on both. Indexes are never reused, so no two payments
--      collide — but a customer CAN send USDT-on-Ethereum to a BEP20 deposit
--      address. Those funds are recoverable (`recover.ts --network=ERC20`)
--      precisely because the address is the same.
--
-- SAFETY
--   Additive. Widening a CHECK constraint cannot invalidate an existing row.
-- =============================================================================

BEGIN;

-- ---------- payments.network: admit ERC20 ------------------------------------
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_network_check;
ALTER TABLE payments
  ADD CONSTRAINT payments_network_check
  CHECK (network IN ('BEP20','TRC20','ERC20'));

-- ---------- per-network payout wallet ----------------------------------------
-- Mirrors payout_wallet_trc20. Deliberately a THIRD column rather than a
-- normalised side table: the existing money path resolves a wallet by network
-- with a CASE, and reshaping that while adding a chain would put a schema
-- migration and a settlement-routing change in the same commit.
--
-- An Ethereum payout address is a 0x address, the same shape as BEP20 — but it
-- is a SEPARATE setting on purpose. A merchant may well want Ethereum
-- settlements going somewhere other than their BSC ones, and silently reusing
-- payout_wallet would move funds to an address they never nominated for this
-- chain.
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS payout_wallet_erc20 TEXT;

COMMENT ON COLUMN clients.payout_wallet_erc20 IS
  'Ethereum (0x…) settlement address. NULL = ERC20 payouts not enabled. '
  'Separate from payout_wallet even though both are 0x addresses: a merchant '
  'may settle Ethereum somewhere other than BSC, and reusing the BEP20 wallet '
  'would send funds to an address never nominated for this chain.';

-- ---------- listener cursors --------------------------------------------------
-- One row per scanning cursor. `ERC20` is the token log scanner; `ERC20_NATIVE`
-- is the block scanner for ETH itself (natives emit no Transfer log — see
-- blockchain/listener.ts). Both start at 0 and are initialised to a safe head on
-- first run rather than walking the chain from genesis.
INSERT INTO chain_cursor (network, last_scanned_block) VALUES
  ('ERC20', 0),
  ('ERC20_NATIVE', 0)
ON CONFLICT (network) DO NOTHING;

-- ---------- assets -----------------------------------------------------------
-- Display/enable state only. Contracts and decimals live in code.
--
-- NOTE the decimals implied here, verified on-chain against mainnet:
--   USDT 6, USDC 6, DAI 18. Ethereum USDT is NOT 18 dp like its BSC cousin.
INSERT INTO assets (network, symbol, display_name, enabled, sort_order) VALUES
  ('ERC20', 'USDT', 'Tether USD',      true,  10),
  ('ERC20', 'USDC', 'USD Coin',        true,  20),
  ('ERC20', 'DAI',  'Dai Stablecoin',  true,  40),
  -- Native, and therefore also gated behind ACCEPT_NATIVE_COINS (migration 012).
  ('ERC20', 'ETH',  'Ether',           false, 90)
ON CONFLICT (network, symbol) DO NOTHING;

COMMIT;
