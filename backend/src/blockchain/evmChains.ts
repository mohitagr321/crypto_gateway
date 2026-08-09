/**
 * Per-chain configuration for the EVM chains this gateway settles on.
 *
 * BSC and Ethereum run identical code — same ethers, same ERC20 ABI, same
 * signing — and differ only in values. This file holds those values so that
 * `evmAdapter.ts` and the listener can be written once and instantiated twice.
 *
 * ============================ WHAT IS **NOT** HERE ===========================
 * No contract addresses. No decimals. Those are properties of an ASSET, not a
 * chain, and live in blockchain/assets.ts — Ethereum USDT is 6 dp while BSC USDT
 * is 18, and USDC is 6 on Ethereum but 18 on BSC. A per-chain `usdtDecimals`
 * would be right for exactly one asset per chain and silently wrong for the
 * rest, which is a 10^12 error on a balance.
 *
 * (An earlier draft of this design, on the unmerged `feat/erc20-multi-network`
 * branch, did carry `usdtContract`/`usdtDecimals` here. That branch predates
 * multi-asset; carrying them forward now would undo it.)
 *
 * ============================ GAS IS THE REAL DIFFERENCE =====================
 * BSC gas is cheap, stable, and paid in fractions of a cent, so a FIXED top-up
 * is fine: send a set amount of BNB to the deposit address and sweep.
 *
 * Ethereum gas is none of those things. A sweep can genuinely cost more than it
 * moves, and the cost changes minute to minute. So Ethereum estimates the fee
 * per sweep and, when it exceeds a ceiling, DEFERS — returns without sweeping,
 * leaving the funds exactly where they are. The minute-ly settle tick re-drives
 * it, so a fee spike costs a delay rather than a failure or a loss.
 */
import { config } from '../config/env';
import { Network } from './networks';

/**
 * How a chain funds a deposit address so it can pay for its own token transfer.
 *
 * Note this is about TOKEN sweeps. A NATIVE sweep is the inverse — it pays out
 * of the balance being moved and is never gas-funded (see sweepNativeDeposit).
 */
export type EvmGasPolicy =
  | {
      /** Send a set amount and go. Correct where gas is cheap and stable. */
      mode: 'fixed';
      topupAmount: string;
    }
  | {
      /** Estimate per sweep, and defer rather than overspend. */
      mode: 'dynamic';
      /**
       * Gas units assumed for an ERC20 transfer when `eth_estimateGas` cannot be
       * reached (its answer is preferred when it can). A transfer costs ~45k to
       * a holder and ~65k to a fresh address; this sits above the worse case.
       */
      fallbackTransferGas: bigint;
      /** Head-room over the estimate, absorbing a base-fee rise before broadcast. */
      bufferPercent: number;
      /**
       * Ceiling on the native top-up, in ether units. Above this the sweep is
       * DEFERRED, not failed — the funds are safe where they are and the settle
       * tick will try again when fees fall.
       */
      maxFeeNative: string;
    };

export interface EvmChainConfig {
  readonly network: Network;
  /** Human label for logs, e.g. 'BSC'. */
  readonly label: string;
  readonly httpRpc: string;
  /** Empty disables the listener's live WS subscription (polling still runs). */
  readonly wsRpc: string;
  readonly chainId: number;
  readonly requiredConfirmations: number;
  /** How far behind head a block is treated as final by the listener. */
  readonly reorgDepth: number;
  /** Native currency, for logs, labels and the native asset: 'BNB' | 'ETH'. */
  readonly feeCurrency: string;
  readonly centralWalletAddress: string;
  readonly centralWalletPrivateKey: string;
  readonly gasStationPrivateKey: string;
  /**
   * Fallback dust floor for callers with no asset in hand. The per-ASSET
   * `minSweep` takes precedence everywhere it is available.
   */
  readonly minSweepAmount: string;
  readonly gasPolicy: EvmGasPolicy;
  /**
   * Blocks per native-scan pass. Natives emit no log, so detection reads whole
   * blocks; the budget is per chain because block times differ by 25x.
   */
  readonly nativeScanRange: number;
}

/**
 * BSC / BEP20 — the original chain. Every value reads from the same env var it
 * always did, so behaviour is byte-for-byte unchanged.
 */
export const BSC: EvmChainConfig = {
  network: 'BEP20',
  label: 'BSC',
  httpRpc: config.chain.httpRpc,
  wsRpc: config.chain.wsRpc,
  chainId: config.chain.chainId,
  requiredConfirmations: config.chain.requiredConfirmations,
  reorgDepth: config.chain.reorgDepth,
  feeCurrency: 'BNB',
  centralWalletAddress: config.centralWalletAddress,
  centralWalletPrivateKey: config.centralWalletPrivateKey,
  gasStationPrivateKey: config.gasStationPrivateKey,
  minSweepAmount: config.settlement.minSweepAmount,
  gasPolicy: { mode: 'fixed', topupAmount: config.settlement.gasTopupBnb },
  // ~0.45s blocks: a 5s pass covers ~11, so this is ~4x head-room.
  nativeScanRange: 40,
};

/**
 * Ethereum / ERC20.
 *
 * The central address is intentionally NOT derived here — evmAdapter derives it
 * from the private key, so the address swept funds land in and the address
 * payouts are signed from can never disagree. `ETH_CENTRAL_WALLET_ADDRESS` is
 * informational and is only used when no key is configured.
 */
export const ETHEREUM: EvmChainConfig = {
  network: 'ERC20',
  label: 'Ethereum',
  httpRpc: config.eth.httpRpc,
  wsRpc: config.eth.wsRpc,
  chainId: config.eth.chainId,
  requiredConfirmations: config.eth.requiredConfirmations,
  reorgDepth: config.eth.reorgDepth,
  feeCurrency: 'ETH',
  centralWalletAddress: config.eth.centralWalletAddress,
  centralWalletPrivateKey: config.eth.centralWalletPrivateKey,
  gasStationPrivateKey: config.eth.gasStationPrivateKey,
  minSweepAmount: config.eth.minSweepAmount,
  gasPolicy: {
    mode: 'dynamic',
    fallbackTransferGas: 90_000n,
    bufferPercent: config.eth.gasBufferPercent,
    maxFeeNative: config.eth.maxSweepFeeEth,
  },
  // ~12s blocks: a 5s pass sees at most one new block, so a small budget still
  // catches up quickly and each block is far heavier than a BSC one.
  nativeScanRange: 10,
};

/** The EVM config for a network, or null for a non-EVM chain (Tron). */
export function evmChain(network: Network): EvmChainConfig | null {
  if (network === 'BEP20') return BSC;
  if (network === 'ERC20') return ETHEREUM;
  return null;
}

/** Every EVM chain this deployment has switched on, in registry order. */
export function enabledEvmChains(): EvmChainConfig[] {
  // Imported lazily to keep this module free of a cycle through networks.ts.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { enabledNetworks } = require('./networks') as typeof import('./networks');
  return (enabledNetworks() as Network[])
    .map((n) => evmChain(n))
    .filter((c): c is EvmChainConfig => c !== null);
}
