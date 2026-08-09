/**
 * BEP20 (BSC) ChainAdapter.
 *
 * All the logic lives in `evmAdapter.ts`, which BSC and Ethereum share — this
 * file is just the BSC instance of it. The behaviour is intended to be
 * unchanged from when this file held the implementation: every value the
 * adapter reads now comes from `BSC` in evmChains.ts, and each of those reads
 * the same env var it always did.
 */
import { ChainAdapter } from './networks';
import { createEvmAdapter } from './evmAdapter';
import { BSC } from './evmChains';

export const bscAdapter: ChainAdapter = createEvmAdapter(BSC);
