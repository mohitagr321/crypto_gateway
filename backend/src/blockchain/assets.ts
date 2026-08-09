/**
 * Asset registry — the single source of truth for what this gateway can settle.
 *
 * ============================== THE MODEL ====================================
 * An ASSET is the pair (network, symbol). `USDT` on BEP20 and `USDT` on TRC20
 * are DIFFERENT assets: different contracts, different decimals (18 vs 6), and
 * separate balances. Funds are not fungible across chains, so nothing may ever
 * sum across them — the same rule that already applies to networks.
 *
 * A payment's asset is fixed at creation and never changes. `payments.asset`
 * plus `payments.network` together identify exactly one row here.
 *
 * ============================ WHY THE CODE IS AUTHORITATIVE ==================
 * There is also an `assets` TABLE, but it carries only `enabled` and display
 * metadata. Contract addresses and decimals live HERE, in code, on purpose:
 * a wrong contract address is a fund-loss bug (payments credited against a token
 * nobody sent) and a wrong decimals value silently mis-scales every amount by
 * orders of magnitude. Neither belongs behind an admin toggle.
 *
 * ============================ DECIMALS ARE NOT A CHAIN PROPERTY ==============
 * `decimals` is per-ASSET, not per-chain. BSC USDT is 18 dp while BSC USDC is
 * ALSO 18 dp, but Tron USDT is 6 dp — and on Ethereum, USDT is 6 dp while DAI is
 * 18 dp on every chain it exists. Never infer decimals from the network.
 *
 * Ledger arithmetic still uses the fixed 18-dp accounting scale in utils/money.ts
 * — that is a property of the ledger, not of any asset, and it holds every asset
 * here losslessly (and would hold BTC's 8 dp too).
 *
 * ============================ NATIVE COINS ARE DIFFERENT =====================
 * BNB and TRX are BOTH fee currencies (`ChainAdapter.feeCurrency`) and, since
 * R5, payable assets. Two things about them are unlike every token here:
 *
 *   1. They have NO CONTRACT, so they emit no `Transfer` log. Detection is by
 *      scanning transactions rather than filtering logs — see the native paths
 *      in blockchain/listener.ts and blockchain/tronListener.ts.
 *   2. Their sweep INVERTS the fee flow. A token sweep funds the deposit address
 *      with gas from the gas station; a native sweep must leave enough behind to
 *      pay its own fee, out of the very balance it is moving.
 *
 * Because getting (2) wrong strands funds at an address rather than failing
 * loudly, natives need `ACCEPT_NATIVE_COINS=true` IN ADDITION to being listed in
 * the network's allowlist. One switch would have been easy to flip by accident.
 */
import { config } from '../config/env';
import { AppError } from '../utils/apiError';
import { Network, NETWORKS } from './networks';

export interface Asset {
  /** Ticker as merchants see it. Unique per network, not globally. */
  symbol: string;
  network: Network;
  /** Human name for the UI. */
  name: string;
  /**
   * Token contract. Empty string for native coins (which have no contract) —
   * see the note above about why those are not yet enabled.
   */
  contract: string;
  /** ON-CHAIN decimals for THIS asset on THIS chain. Never assume per-chain. */
  decimals: number;
  /** Below this, a sweep costs more in fees than it moves. Human units. */
  minSweep: string;
  /** The chain's own coin (BNB, TRX). Detection and sweeping differ entirely. */
  isNative: boolean;
}

/**
 * Every asset the code knows how to handle. Presence here does NOT mean enabled
 * — see `enabledAssets()`. Adding a row is not sufficient to accept a token: it
 * must also survive the boot validation below.
 */
const CATALOGUE: Asset[] = [
  // ---- BEP20 (BNB Smart Chain) ----
  // NOTE: BSC's bridged stablecoins are 18 dp, unlike their Ethereum originals
  // (USDT and USDC are 6 dp on Ethereum). This is the classic multi-chain
  // decimals trap and exactly why decimals live per-asset.
  {
    symbol: 'USDT',
    network: 'BEP20',
    name: 'Tether USD',
    contract: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    minSweep: '1.0',
    isNative: false,
  },
  {
    symbol: 'USDC',
    network: 'BEP20',
    name: 'USD Coin',
    contract: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    decimals: 18,
    minSweep: '1.0',
    isNative: false,
  },
  {
    symbol: 'BUSD',
    network: 'BEP20',
    name: 'Binance USD',
    contract: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    decimals: 18,
    minSweep: '1.0',
    isNative: false,
  },
  {
    symbol: 'DAI',
    network: 'BEP20',
    name: 'Dai Stablecoin',
    contract: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
    decimals: 18,
    minSweep: '1.0',
    isNative: false,
  },

  // ---- ERC20 (Ethereum) ----
  //
  // READ THE DECIMALS. USDT and USDC on Ethereum are 6 dp; their BSC
  // counterparts above are 18. This is the single most expensive mistake
  // available in this file — treating an Ethereum USDT balance as 18 dp
  // under-reads it by a factor of 10^12, so a 1,000,000 USDT deposit is seen as
  // 0.000001 and never credited. Each value below was read from the contract on
  // mainnet, not assumed.
  {
    symbol: 'USDT',
    network: 'ERC20',
    name: 'Tether USD',
    contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    // Ethereum gas can genuinely exceed a small payment; see ETH_MIN_SWEEP_AMOUNT.
    minSweep: '20',
    isNative: false,
  },
  {
    symbol: 'USDC',
    network: 'ERC20',
    name: 'USD Coin',
    contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    minSweep: '20',
    isNative: false,
  },
  {
    symbol: 'DAI',
    network: 'ERC20',
    name: 'Dai Stablecoin',
    // 18 dp, unlike the two above — which is exactly why decimals are per-asset.
    contract: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    minSweep: '20',
    isNative: false,
  },
  {
    symbol: 'ETH',
    network: 'ERC20',
    name: 'Ether',
    contract: '',
    decimals: 18,
    // ~0.005 ETH. Above a typical transfer fee by enough that the sweep is worth
    // making, and the dynamic gas policy defers it rather than failing when it
    // is not.
    minSweep: '0.005',
    isNative: true,
  },

  // ---- Bitcoin ----
  // The whole network, in one row. Bitcoin has no token layer, so BTC is both
  // the native coin and the only thing this chain can settle — which is why it
  // is exempt from the ACCEPT_NATIVE_COINS gate (see enabledAssets).
  //
  // 8 dp. The ledger's 18-dp accounting scale holds that losslessly; utils/
  // money.ts called this out before Bitcoin existed here.
  {
    symbol: 'BTC',
    network: 'BTC',
    name: 'Bitcoin',
    contract: '',
    decimals: 8,
    // ~0.0001 BTC. A 1-input sweep is ~110 vB, so at 20 sat/vB the fee is about
    // 2,200 sat — this floor keeps the fee a small fraction of what moves.
    minSweep: '0.0001',
    isNative: true,
  },

  // ---- TRC20 (Tron) ----
  // Tron stablecoins are 6 dp. A Tron sweep also burns ~13-30 TRX in energy when
  // the sender has no staked energy, so minSweep is higher than on BSC — below
  // it, settling costs more than it moves.
  {
    symbol: 'USDT',
    network: 'TRC20',
    name: 'Tether USD',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    minSweep: '1.0',
    isNative: false,
  },
  {
    symbol: 'USDC',
    network: 'TRC20',
    name: 'USD Coin',
    contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
    decimals: 6,
    minSweep: '1.0',
    isNative: false,
  },
  {
    symbol: 'USDD',
    network: 'TRC20',
    name: 'Decentralized USD',
    contract: 'TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn',
    decimals: 18,
    minSweep: '1.0',
    isNative: false,
  },

  // ---- Native coins (see the header) ----
  // `contract` is empty because there is nothing to call: these are the chains'
  // own currency. The minimums below became load-bearing when R5 made natives
  // payable, so they are set against what a sweep actually costs rather than
  // left at the placeholder values they had while natives were inert.
  {
    symbol: 'BNB',
    network: 'BEP20',
    name: 'BNB',
    contract: '',
    decimals: 18,
    // A 21,000-gas transfer costs ~0.000001 BNB at 0.05 gwei, so this floor is
    // about a thousand times the fee — comfortably above the point where the
    // sweep would eat the payment.
    minSweep: '0.002',
    isNative: true,
  },
  {
    symbol: 'TRX',
    network: 'TRC20',
    name: 'TRON',
    contract: '',
    decimals: 6,
    // A native TRX transfer is usually FREE: a fresh account's daily free
    // bandwidth (600 bytes) covers the ~270-byte transaction. The old '50'
    // placeholder was carried over from the TRC20 token floor, where an
    // energy burn of 13-30 TRX genuinely justifies it; for natives it would
    // have rejected perfectly economic payments.
    minSweep: '10',
    isNative: true,
  },
];

/** The asset used when an API caller does not specify one. Do not change. */
export const DEFAULT_ASSET = 'USDT';

/**
 * The asset an API caller gets when they name a network but not an asset.
 *
 * USDT everywhere it exists — that is the historical default and every
 * integration predating multi-asset depends on it. Bitcoin is the exception
 * because USDT simply is not a thing there: BTC is the only asset the chain has,
 * so defaulting to USDT would make every BTC payment that omitted `asset` fail
 * with "not available on BTC" instead of doing the obvious thing.
 */
export function defaultAssetFor(network: Network): string {
  return network === 'BTC' ? 'BTC' : DEFAULT_ASSET;
}

/**
 * USDT's contract and decimals stay overridable from env on both chains, because
 * they always were (`USDT_CONTRACT`, `TRON_USDT_CONTRACT`) and a testnet
 * deployment depends on it — Nile's USDT is a different address from mainnet's.
 * Every other asset is mainnet-only until there is a reason to do otherwise.
 */
function applyEnvOverrides(asset: Asset): Asset {
  if (asset.symbol !== 'USDT') return asset;
  if (asset.network === 'BEP20') {
    return {
      ...asset,
      contract: config.chain.usdtContract || asset.contract,
      decimals: config.chain.usdtDecimals ?? asset.decimals,
      minSweep: config.settlement.minSweepAmount || asset.minSweep,
    };
  }
  if (asset.network === 'TRC20') {
    return {
      ...asset,
      contract: config.tron.usdtContract || asset.contract,
      decimals: config.tron.usdtDecimals ?? asset.decimals,
      minSweep: config.tron.minSweepAmount || asset.minSweep,
    };
  }
  if (asset.network === 'ERC20') {
    return {
      ...asset,
      contract: config.eth.usdtContract || asset.contract,
      decimals: config.eth.usdtDecimals ?? asset.decimals,
      minSweep: config.eth.minSweepAmount || asset.minSweep,
    };
  }
  return asset;
}

/**
 * Which assets this deployment actually accepts.
 *
 * Two gates, both of which must pass:
 *   1. The NETWORK is enabled (`ASSETS_BEP20` is moot if TRON is off, etc.) —
 *      reuses the existing network gating so an asset can never outlive its chain.
 *   2. The SYMBOL is listed in that network's env allowlist.
 *
 * USDT is always included on an enabled network: it is what every existing
 * integration uses, and dropping it out of an allowlist typo would break them.
 */
function envAllowlist(network: Network): Set<string> {
  const raw =
    network === 'BEP20'
      ? config.assets.bep20
      : network === 'TRC20'
        ? config.assets.trc20
        : network === 'ERC20'
          ? config.assets.erc20
          : '';
  const listed = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  // The chain's default asset is non-negotiable — see above. On the token
  // chains that is USDT; on Bitcoin it is BTC, which is the only asset there is.
  return new Set([defaultAssetFor(network), ...listed]);
}

let cached: Asset[] | null = null;

export function enabledAssets(): Asset[] {
  if (cached) return cached;

  // Imported lazily to avoid a module cycle: networks.ts must not depend on this.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { enabledNetworks } = require('./networks') as typeof import('./networks');
  const liveNetworks = new Set(enabledNetworks());

  cached = CATALOGUE.filter((a) => {
    if (!liveNetworks.has(a.network)) return false;

    // ACCEPT_NATIVE_COINS exists because accepting a chain's GAS currency as
    // payment inverts the sweep's fee flow — a native sweep pays out of the
    // balance it is moving instead of being funded by the gas station.
    //
    // Bitcoin has no gas currency to invert against: BTC is the only asset the
    // chain has, and its sweep ALWAYS worked that way. Gating it behind that
    // flag would mean BTC_ENABLED=true did nothing on its own, which is a trap
    // rather than a safeguard. So the gate applies to chains with a token layer.
    const hasTokenLayer = a.network !== 'BTC';
    if (a.isNative && hasTokenLayer && !config.assets.acceptNative) return false;

    return envAllowlist(a.network).has(a.symbol.toUpperCase());
  }).map(applyEnvOverrides);

  return cached;
}

/** Test seam: forget the memoised list (config is immutable at runtime). */
export function resetAssetCache(): void {
  cached = null;
}

/**
 * Look up an enabled asset. Throws a 400 rather than returning undefined so a
 * bad `asset` from an API caller can never reach the chain layer as a silent
 * fallback to USDT — crediting the wrong token is a fund-loss bug.
 */
export function assetFor(network: Network, symbol: string): Asset {
  const wanted = String(symbol || defaultAssetFor(network)).toUpperCase();
  const found = enabledAssets().find(
    (a) => a.network === network && a.symbol === wanted,
  );
  if (!found) {
    const available = enabledAssets()
      .filter((a) => a.network === network)
      .map((a) => a.symbol);
    throw AppError.badRequest(
      `Asset "${symbol}" is not available on ${network}. ` +
        `Supported on ${network}: ${available.join(', ') || 'none'}.`,
    );
  }
  return found;
}

/**
 * Parse an untrusted `asset` from a request. Undefined/empty -> USDT, exactly
 * how `parseNetwork` defaults the network, so an existing integration that has
 * never heard of assets keeps its current behaviour.
 */
export function parseAsset(network: Network, value: unknown): Asset {
  if (value === undefined || value === null || value === '') {
    return assetFor(network, defaultAssetFor(network));
  }
  return assetFor(network, String(value));
}

export function isKnownAsset(network: Network, symbol: string): boolean {
  return enabledAssets().some(
    (a) => a.network === network && a.symbol === String(symbol).toUpperCase(),
  );
}

/** Every enabled contract address on a chain, for the listener's log filter. */
export function contractsFor(network: Network): string[] {
  return enabledAssets()
    .filter((a) => a.network === network && !a.isNative && a.contract)
    .map((a) => a.contract);
}

/**
 * Reverse lookup used by the listeners: a Transfer log arrives carrying a
 * contract address, and it must be resolved to the asset it credits. Returns
 * undefined for an unrecognised contract — the caller IGNORES those rather than
 * guessing, because crediting an unknown token as USDT would be a loss.
 *
 * Case-insensitive on EVM (log addresses are not checksummed consistently);
 * exact on Tron (base58 is case-sensitive).
 */
export function assetByContract(
  network: Network,
  contract: string,
): Asset | undefined {
  const needle = network === 'TRC20' ? contract : contract.toLowerCase();
  return enabledAssets().find((a) => {
    if (a.network !== network || !a.contract) return false;
    return network === 'TRC20'
      ? a.contract === needle
      : a.contract.toLowerCase() === needle;
  });
}

/** All (network, symbol) pairs — the shape the /assets capability probe returns. */
export function assetCatalogue(): Array<{
  symbol: string;
  network: string;
  name: string;
  decimals: number;
  minAmount: string;
  isNative: boolean;
}> {
  return enabledAssets().map((a) => ({
    symbol: a.symbol,
    network: a.network,
    name: a.name,
    decimals: a.decimals,
    minAmount: a.minSweep,
    // Published so the checkout can tell a customer that this is the chain's own
    // coin, not a token — the practical difference being that sending it from
    // an exchange requires picking the right withdrawal network, and a contract
    // address will not appear anywhere.
    isNative: a.isNative,
  }));
}

/**
 * The enabled native coin for a chain, or undefined when natives are off.
 * Used by the listeners to decide whether to run a native scan at all.
 */
export function nativeAssetFor(network: Network): Asset | undefined {
  return enabledAssets().find((a) => a.network === network && a.isNative);
}

/** Enabled TOKENS (everything with a contract) — the log-driven detection set. */
export function tokenAssetsFor(network: Network): Asset[] {
  return enabledAssets().filter((a) => a.network === network && !a.isNative);
}

/**
 * Boot validation. Called once at startup so a misconfigured asset fails fast
 * rather than at the moment a customer's money is on the line — the same
 * fail-fast principle as the wallet guards in config/env.ts.
 */
export function validateAssets(): void {
  validateAssetList(enabledAssets());
}

/**
 * The rules, applied to an explicit list.
 *
 * Split out from `validateAssets` so the guards can be exercised against a
 * hand-built catalogue — otherwise they are unreachable from a test, since the
 * real list comes from a module-private constant and the only way to reach a
 * violation is to have already shipped one.
 */
export function validateAssetList(assets: Asset[]): void {
  const seen = new Set<string>();
  for (const a of assets) {
    const key = `${a.network}:${a.symbol}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate asset in registry: ${key}`);
    }
    seen.add(key);

    if (!Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 18) {
      throw new Error(`Asset ${key} has implausible decimals: ${a.decimals}`);
    }

    if (a.isNative) {
      // A native coin has no contract by definition, and a non-empty one would
      // mean the catalogue is confusing it with a wrapped token (WBNB is a
      // different asset with different semantics — it emits Transfer logs and
      // sweeps like any other token).
      if (a.contract) {
        throw new Error(
          `Asset ${key} is marked native but carries a contract address (${a.contract}). ` +
            `A wrapped token is not the native coin.`,
        );
      }
      continue;
    }

    if (!a.contract) {
      throw new Error(`Asset ${key} is enabled but has no contract address`);
    }
    if (a.network === 'BEP20' && !/^0x[0-9a-fA-F]{40}$/.test(a.contract)) {
      throw new Error(`Asset ${key} contract is not a 0x address: ${a.contract}`);
    }
    if (a.network === 'TRC20' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a.contract)) {
      throw new Error(`Asset ${key} contract is not a base58 T… address: ${a.contract}`);
    }
  }

  // Two different symbols pointing at one contract would double-credit a single
  // Transfer log, since assetByContract resolves to whichever it finds first.
  for (const network of NETWORKS) {
    const contracts = assets
      .filter((a) => a.network === network && a.contract)
      .map((a) => a.contract.toLowerCase());
    if (new Set(contracts).size !== contracts.length) {
      throw new Error(`Duplicate contract address among ${network} assets`);
    }
  }
}
