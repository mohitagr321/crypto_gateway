/**
 * ERC20 (Ethereum) ChainAdapter.
 *
 * The Ethereum instance of the shared EVM adapter. Everything that differs from
 * BSC is a value in `ETHEREUM` (evmChains.ts), not a branch in the code:
 *
 *   - Gas is estimated per sweep and a sweep whose fee exceeds the ceiling is
 *     DEFERRED rather than failed. On BSC a fixed top-up is fine; on Ethereum a
 *     sweep can genuinely cost more than it moves.
 *   - Confirmations and reorg depth are counted in ~12s blocks, not ~0.45s ones.
 *   - The dust floor is far higher, for the same fee reason.
 *
 * Decimals are NOT here and are not a chain property: Ethereum USDT and USDC are
 * 6 dp while DAI is 18, and the BSC versions of the first two are 18. That lives
 * per-asset in blockchain/assets.ts.
 *
 * Loaded lazily by networks.ts and only when ERC20 is enabled, so a BSC-only
 * deployment never constructs an Ethereum provider.
 */
import { ChainAdapter } from './networks';
import { createEvmAdapter } from './evmAdapter';
import { ETHEREUM } from './evmChains';

export const ethAdapter: ChainAdapter = createEvmAdapter(ETHEREUM);
