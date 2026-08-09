/**
 * Network registry + the ChainAdapter contract.
 *
 * The gateway settles USDT on more than one chain. Everything chain-specific
 * lives behind a ChainAdapter so services (payments, payouts, sweeps) stay
 * chain-agnostic and dispatch on `payments.network`.
 *
 *   BEP20 -> BSC, EVM, ethers, gas paid in BNB
 *   ERC20 -> Ethereum, EVM, ethers, gas paid in ETH (expensive and volatile)
 *   TRC20 -> Tron, non-EVM, tronweb, fees paid in TRX (energy/bandwidth)
 *   BTC   -> Bitcoin, UTXO, bitcoinjs-lib, fees priced by transaction SIZE
 *
 * BITCOIN IS THE ODD ONE. Every other chain has ACCOUNTS — an address has a
 * balance. Bitcoin has UTXOs: an address holds a set of unspent outputs, and a
 * spend consumes them whole. `ChainAdapter` still fits, because it speaks in
 * human amounts and hides mechanics behind each implementation, but two of its
 * assumptions bend: there is no nonce (idempotence comes from re-broadcasting
 * identical bytes) and there is no separate gas currency (a sweep pays its fee
 * out of what it moves, always).
 *
 * DECIMALS ARE NOT LISTED HERE ON PURPOSE. They are a property of the ASSET, not
 * the chain — Ethereum USDT is 6 dp while BSC USDT is 18 — and live in
 * blockchain/assets.ts. Any per-chain decimals constant is a 10^12 bug waiting
 * to happen.
 *
 * IMPORTANT INVARIANTS
 *  - BEP20 is always enabled: it is the original network and the default for any
 *    payment created without an explicit `network`. Existing API clients that
 *    never send `network` therefore keep their exact current behaviour.
 *  - TRC20 is enabled ONLY when TRON_ENABLED=true and its wallet config is valid.
 *    ERC20 likewise requires ETH_ENABLED=true and an RPC. While disabled,
 *    adapterFor() throws and the network is rejected at the API edge, so a
 *    half-configured deployment can never accept funds it cannot sweep.
 *  - Adapters are resolved lazily (see adapterFor) so that merely importing this
 *    module never constructs a Tron client on a BEP20-only deployment.
 *
 * ============================ EVM CHAINS SHARE ADDRESSES =====================
 * BEP20 and ERC20 both derive from BIP-44 coin type 60, so HD index N is the
 * SAME address on both chains. Deposit indexes are never reused, so no two
 * payments collide — but it does mean a customer can send an Ethereum token to a
 * BSC deposit address (and vice versa). Those funds are recoverable exactly
 * because the address is shared: see `recover.ts --network=`.
 */
import { AppError } from '../utils/apiError';

export const NETWORKS = ['BEP20', 'TRC20', 'ERC20', 'BTC'] as const;
export type Network = (typeof NETWORKS)[number];

/** The network used when an API caller does not specify one. Do not change. */
export const DEFAULT_NETWORK: Network = 'BEP20';

export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value);
}

/**
 * Parse an untrusted `network` value from an API request.
 * Undefined/empty -> DEFAULT_NETWORK (back-compat for existing integrations).
 */
export function parseNetwork(value: unknown): Network {
  if (value === undefined || value === null || value === '') return DEFAULT_NETWORK;
  const upper = String(value).toUpperCase();
  if (!isNetwork(upper)) {
    throw AppError.badRequest(
      `Unsupported network "${String(value)}". Supported: ${NETWORKS.join(', ')}`,
    );
  }
  return upper;
}

/** Result of a sweep: null when there was nothing worth sweeping (dust). */
export interface SweepResult {
  txHash: string;
  /** Human amount actually swept, in `asset`. */
  amount: string;
  /** Which asset was swept. Defaults to USDT for pre-multi-asset callers. */
  asset?: string;
}

/**
 * Everything the chain-agnostic services need from a chain.
 *
 * All amounts crossing this interface are HUMAN strings (e.g. "12.5"). Base-unit
 * conversion is each adapter's private business, because the scale differs per
 * chain (18 vs 6). This is what keeps the 10^12 TRC20/BEP20 scaling bug out of
 * the services.
 */
export interface ChainAdapter {
  readonly network: Network;
  /** Native fee currency, for logs/labels: 'BNB' | 'TRX'. */
  readonly feeCurrency: string;
  /** Confirmations required before a payment is promoted to `confirmed`. */
  readonly requiredConfirmations: number;
  /** Address that swept deposits land in and payouts are signed from. */
  readonly centralWalletAddress: string;
  /**
   * Address that funds deposit addresses with native currency so they can pay
   * their own sweep fee. Empty string when no gas key is configured for this
   * chain — the admin panel renders that as "not configured" rather than 0.
   */
  readonly gasStationAddress: string;
  /**
   * Minimum human balance worth sweeping (dust guard) for the chain's DEFAULT
   * asset. Per-asset minimums live on the asset registry entry and take
   * precedence; this remains for callers that have no asset in hand.
   */
  readonly minSweepAmount: string;

  /** True if `address` is well-formed for this chain. */
  isValidAddress(address: string): boolean;

  /** Derive the deposit address for an HD index. Pure fn of mnemonic + index. */
  deriveDeposit(index: number): { address: string; path: string };

  /** On-chain USDT balance of an address, as a human string. */
  balanceOf(address: string, asset?: string): Promise<string>;

  /**
   * On-chain NATIVE balance of an address (BNB / TRX), as a human string.
   * This is the number that decides whether sweeps and payouts can run at all:
   * when the gas wallet hits zero, every transfer on this chain fails. The
   * admin panel surfaces it so that is visible before it bites.
   */
  nativeBalanceOf(address: string): Promise<string>;

  /** Wallet-scannable payment URI for the QR code. */
  paymentUri(address: string, amountHuman: string, asset?: string): string;

  /**
   * Move the full USDT balance of a deposit address to the central wallet,
   * funding native fees first if needed. Returns null if below minSweepAmount.
   * Implementations MUST be safe to retry.
   */
  sweepDeposit(params: {
    paymentId: string;
    depositAddress: string;
    derivationIndex: number;
    /**
     * Which token to sweep. Omitted -> USDT, so a caller that predates
     * multi-asset behaves exactly as before. The adapter resolves the contract
     * and decimals from the registry; it must never assume the chain's default.
     */
    asset?: string;
  }): Promise<SweepResult | null>;

  /**
   * Send USDT from the central wallet to `to`. Returns the broadcast tx hash.
   *
   * PREFER preparePayout + broadcastPayout where the chain supports them. This
   * one-shot form gives the caller no way to know whether a thrown error means
   * "nothing was sent" or "sent, but the response was lost", which is exactly
   * the ambiguity that let a retry pay a merchant twice.
   */
  sendPayout(params: {
    to: string;
    amountHuman: string;
    asset?: string;
  }): Promise<{ txHash: string }>;

  /**
   * Sign a payout WITHOUT broadcasting it, pinned so that re-broadcasting is a
   * no-op rather than a second transfer.
   *
   * The caller persists the result before sending, so a retry re-broadcasts the
   * same bytes instead of signing a new transfer. Pass the stored `nonce` back
   * on a retry to keep the pin even if a re-sign is needed.
   *
   * Absent on chains with no equivalent guarantee — see PayoutPreparation.
   */
  preparePayout?(params: {
    to: string;
    amountHuman: string;
    nonce?: number | null;
    asset?: string;
  }): Promise<PayoutPreparation>;

  /**
   * Broadcast bytes from preparePayout. MUST resolve (not throw) when the
   * transaction is already known to the node or already mined — that is the
   * expected outcome of a retry, not an error.
   */
  broadcastPayout?(signedTx: string): Promise<{ txHash: string }>;

  /**
   * Wait for one confirmation, bounded. Resolves true when the tx succeeded
   * on-chain, false when it did not confirm in time. MUST NOT block forever:
   * callers run inside a worker, and an unbounded wait stalls the queue.
   */
  waitForTx(txHash: string): Promise<boolean>;
}

/** A signed, not-yet-broadcast payout. */
export interface PayoutPreparation {
  /**
   * The account nonce the transaction is pinned to. A chain mines at most one
   * transaction per nonce, so this is what makes a double-pay impossible even
   * if the signed bytes are lost and the payout is re-signed.
   */
  nonce: number;
  /** Raw signed transaction, hex. Re-broadcasting these bytes is idempotent. */
  signedTx: string;
  /** The hash these bytes will have on-chain, known before broadcasting. */
  txHash: string;
}

// --- Registry ---------------------------------------------------------------
// Adapters are required lazily to avoid constructing chain clients (and, for
// Tron, importing tronweb) on deployments that don't use them.

const cache = new Map<Network, ChainAdapter>();

function loadAdapter(network: Network): ChainAdapter {
  switch (network) {
    case 'BEP20': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      return require('./bscAdapter').bscAdapter as ChainAdapter;
    }
    case 'ERC20': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      return require('./ethAdapter').ethAdapter as ChainAdapter;
    }
    case 'TRC20': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      return require('./tronAdapter').tronAdapter as ChainAdapter;
    }
    case 'BTC': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
      return require('./bitcoinAdapter').bitcoinAdapter as ChainAdapter;
    }
    default: {
      const never: never = network;
      throw new Error(`no adapter for network ${String(never)}`);
    }
  }
}

/**
 * Resolve the adapter for a network.
 * Throws AppError(400) when the network exists but is not enabled on this
 * deployment — callers surface that to the merchant rather than 500-ing.
 */
export function adapterFor(network: Network): ChainAdapter {
  if (!isNetworkEnabled(network)) {
    throw AppError.badRequest(
      `Network ${network} is not enabled on this gateway. Supported right now: ${enabledNetworks().join(', ')}`,
    );
  }
  let adapter = cache.get(network);
  if (!adapter) {
    adapter = loadAdapter(network);
    cache.set(network, adapter);
  }
  return adapter;
}

export function isNetworkEnabled(network: Network): boolean {
  if (network === 'BEP20') return true; // always on — the original network
  // Read config lazily; env.ts imports nothing from here, so this stays acyclic.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { config } = require('../config/env') as typeof import('../config/env');
  if (network === 'TRC20') return config.tron.enabled;
  // ERC20 needs an RPC as well as the flag: unlike BSC there is no usable
  // default endpoint, and booting without one would mint Ethereum deposit
  // addresses this gateway could never watch or sweep.
  if (network === 'ERC20') return config.eth.enabled && Boolean(config.eth.httpRpc);
  // Bitcoin needs only the flag: its API (Blockstream/mempool.space Esplora) is
  // keyless and has a working default, so there is no half-configured state
  // where addresses could be minted but not watched.
  if (network === 'BTC') return config.btc.enabled;
  return false;
}

/** Networks this deployment can actually accept and settle on. */
export function enabledNetworks(): Network[] {
  return NETWORKS.filter((n) => isNetworkEnabled(n));
}
