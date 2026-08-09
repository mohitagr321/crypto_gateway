/**
 * BEP20 / BSC blockchain listener (standalone: `node dist/blockchain/listener.js`).
 *
 * The implementation is shared with Ethereum and lives in `evmListener.ts`; this
 * file only says WHICH chain this process owns. The Ethereum equivalent is
 * `ethListener.ts`, and the non-EVM one is `tronListener.ts`.
 *
 * One chain per process, deliberately: block numbers and confirmation counts are
 * meaningless across chains, and giving each its own process means an RPC outage
 * on one cannot stall detection on another.
 */
import { runEvmListener } from './evmListener';
import { BSC } from './evmChains';

void runEvmListener(BSC);
