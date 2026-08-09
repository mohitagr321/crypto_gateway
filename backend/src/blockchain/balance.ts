/**
 * On-chain read helpers for the admin panel.
 *
 * Kept separate from usdt.ts so admin routes don't pull in the WS provider /
 * signer surface, and network-aware so the panel can show the health of EVERY
 * chain the gateway settles on — not just BSC.
 *
 * Everything here goes through ChainAdapter, so adding a third chain later means
 * adding an adapter, not touching this file.
 */
import { adapterFor, enabledNetworks, Network } from './networks';

/** A single wallet's on-chain position on one chain. */
export interface WalletBalance {
  address: string;
  label: string;
  /** Human USDT balance. '0' if the read failed. */
  usdt: string;
  /** Human native balance (BNB / TRX). '0' if the read failed. */
  native: string;
  /** 'BNB' | 'TRX' — what `native` is denominated in. */
  nativeCurrency: string;
  /** False when this chain has no key configured for this role. */
  configured: boolean;
}

export interface NetworkBalances {
  network: Network;
  feeCurrency: string;
  central: WalletBalance;
  gas: WalletBalance;
  /**
   * True when the gas wallet's native balance has fallen below the point where
   * it can still fund sweeps. The panel turns this into a visible warning
   * BEFORE settlement stalls, which is the whole reason this endpoint exists.
   */
  lowGas: boolean;
}

/**
 * How much native currency the gas wallet should keep on hand before we warn.
 * Deliberately generous — a warning that fires early is useful; one that fires
 * as the last sweep fails is not.
 *
 * BNB: a BSC USDT transfer costs well under 0.001 BNB, so 0.05 is many hundreds
 * of sweeps. TRX: a TRC20 transfer burns ~13-30 TRX without staked energy, so
 * 200 TRX is only ~7-15 sweeps — Tron genuinely needs watching.
 *
 * ETH: the tightest of the three. An Ethereum token sweep can cost 0.002-0.01
 * ETH depending on the base fee, so 0.05 is only a handful of sweeps — and
 * unlike BSC, running dry here does not merely stall settlement, it stalls it at
 * the exact moment fees are high and the backlog is growing.
 */
const LOW_GAS_THRESHOLD: Record<Network, number> = {
  BEP20: 0.05,
  ERC20: 0.05,
  TRC20: 200,
  // Bitcoin has no gas wallet to run dry: a sweep pays its fee out of the funds
  // it is moving, so there is nothing to top up and nothing to warn about. Zero
  // means the warning can never fire, which is the accurate answer rather than
  // a threshold invented to fill the slot.
  BTC: 0,
};

/** Never let one unreachable RPC blank the whole admin page. */
async function safe(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch {
    return '0';
  }
}

/**
 * Read the USDT balance of a BEP20 address.
 * Retained with its original single-chain signature because existing callers
 * still use it; new code should prefer `balancesForNetwork`.
 */
export async function balanceOfAddress(address: string): Promise<string> {
  return adapterFor('BEP20').balanceOf(address);
}

/** Central + gas wallet positions for one chain. Never throws. */
export async function balancesForNetwork(network: Network): Promise<NetworkBalances> {
  const adapter = adapterFor(network);
  const centralAddress = adapter.centralWalletAddress;
  const gasAddress = adapter.gasStationAddress;

  // A missing address means "not configured" — skip the RPC round-trip entirely
  // rather than querying the zero address and reporting a misleading 0.
  const readWallet = async (address: string, label: string): Promise<WalletBalance> => {
    if (!address) {
      return {
        address: '',
        label,
        usdt: '0',
        native: '0',
        nativeCurrency: adapter.feeCurrency,
        configured: false,
      };
    }
    const [usdt, native] = await Promise.all([
      safe(() => adapter.balanceOf(address)),
      safe(() => adapter.nativeBalanceOf(address)),
    ]);
    return { address, label, usdt, native, nativeCurrency: adapter.feeCurrency, configured: true };
  };

  const [central, gas] = await Promise.all([
    readWallet(centralAddress, 'Central'),
    readWallet(gasAddress, 'Gas station'),
  ]);

  return {
    network,
    feeCurrency: adapter.feeCurrency,
    central,
    gas,
    lowGas: gas.configured && Number(gas.native) < LOW_GAS_THRESHOLD[network],
  };
}

/**
 * Central + gas positions for every ENABLED chain, in registry order (BEP20
 * first). A disabled chain is omitted rather than shown as zeroes, so a
 * BEP20-only deployment renders exactly as it did before TRC20 existed.
 */
export async function allNetworkBalances(): Promise<NetworkBalances[]> {
  return Promise.all(enabledNetworks().map((n) => balancesForNetwork(n)));
}
