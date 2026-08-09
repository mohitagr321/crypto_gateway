/**
 * ERC20 / Ethereum blockchain listener
 * (standalone: `node dist/blockchain/ethListener.js`).
 *
 * Same implementation as the BSC listener — see `evmListener.ts` — instantiated
 * with the Ethereum config. Everything that differs is a value: a ~12s block
 * time instead of ~0.45s, a much smaller native scan budget per pass, and its
 * own confirmation and reorg depths.
 *
 * A NO-OP unless ERC20 is enabled: it logs and idles, so it is always safe to
 * add to the process supervisor. That mirrors tronListener.ts and means an
 * operator can deploy the full process set before configuring every chain.
 */
import { logger } from '../config/logger';
import { runEvmListener } from './evmListener';
import { ETHEREUM } from './evmChains';
import { isNetworkEnabled } from './networks';

if (!isNetworkEnabled('ERC20')) {
  logger.warn(
    'ETH_ENABLED=false (or ETH_HTTP_RPC unset) — Ethereum listener idle. ' +
      'Set both to enable ERC20.',
  );
  // Stay alive so a process supervisor does not flap on a crash-restart loop.
  setInterval(() => undefined, 1 << 30);
} else {
  void runEvmListener(ETHEREUM);
}
