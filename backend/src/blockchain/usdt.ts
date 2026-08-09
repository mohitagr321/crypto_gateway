/**
 * BEP20 token contract wiring for ethers v6.
 *
 * Named `usdt.ts` for history — it now serves EVERY enabled BEP20 asset, not
 * just USDT. The ABI is identical for any ERC20-shaped token, so the only thing
 * that varies per asset is the contract address and the decimals.
 *
 * DECIMALS ARE PER-ASSET, NOT PER-CHAIN. BSC USDT and BSC USDC are both 18 dp
 * but Tron USDT is 6 dp, and on Ethereum USDT is 6 dp while DAI is 18 dp
 * everywhere. Every function below therefore takes the asset it is operating on.
 * The no-argument forms default to USDT purely so existing call sites — and the
 * behaviour they had before multi-asset — are unchanged.
 *
 * All on-chain money math is BigInt; convert to/from human strings only at the
 * DB / API boundary, and always with the decimals of the asset in hand.
 */
import {
  Contract,
  JsonRpcProvider,
  WebSocketProvider,
  Wallet,
  formatUnits,
  parseUnits,
} from 'ethers';
import { config } from '../config/env';
import { Asset, assetFor } from './assets';

// Minimal ABI: what the listener (events + reads) and sweeper/payout (writes) need.
export const USDT_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 value) returns (bool)',
] as const;

/**
 * HTTP provider for a specific EVM chain (reads, tx submission, reconciler).
 *
 * Takes the endpoint and chain id explicitly rather than reading config, so BSC
 * and Ethereum share one construction path. `staticNetwork` skips the chain-id
 * round-trip on every call, which matters more on a metered endpoint.
 */
export function httpProviderFor(rpcUrl: string, chainId: number): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
}

/** BSC's HTTP provider. Retained so pre-multi-chain call sites are unchanged. */
export function httpProvider(): JsonRpcProvider {
  return httpProviderFor(config.chain.httpRpc, config.chain.chainId);
}

/**
 * Provider for NATIVE block scanning — batching disabled, deliberately.
 *
 * By default ethers coalesces concurrent JSON-RPC calls into one batch request.
 * That is a win for the token path (a handful of eth_getLogs), but native
 * detection fetches whole blocks one after another, and a public BSC node
 * rejects the resulting batch outright:
 *
 *   -32005 "method eth_getLogs in batch triggered rate limit"
 *
 * Note WHICH method it names. Because the provider is shared, the batch mixed
 * the block fetches in with the token scan's log query, so the rate limit took
 * BOTH down together — the token cursor stalled on native traffic, which is the
 * exact coupling the separate cursors exist to prevent. Separate cursors are not
 * enough if the transport is shared.
 *
 * `batchMaxCount: 1` sends one request per call, in order. Slower per block, and
 * the only thing a public endpoint will actually serve.
 */
export function nativeScanProviderFor(rpcUrl: string, chainId: number): JsonRpcProvider {
  return new JsonRpcProvider(rpcUrl, chainId, {
    staticNetwork: true,
    batchMaxCount: 1,
  });
}

/** BSC's non-batching provider. */
export function nativeScanProvider(): JsonRpcProvider {
  return nativeScanProviderFor(config.chain.httpRpc, config.chain.chainId);
}

/**
 * WebSocket provider for live Transfer subscriptions.
 * The caller owns the lifecycle (reconnect on close) — see listener.ts.
 */
export function wsProviderFor(rpcUrl: string, chainId: number): WebSocketProvider {
  return new WebSocketProvider(rpcUrl, chainId);
}

export function wsProvider(): WebSocketProvider {
  return wsProviderFor(config.chain.wsRpc, config.chain.chainId);
}

/** The BEP20 USDT asset — the default for every call that omits one. */
function defaultAsset(): Asset {
  return assetFor('BEP20', 'USDT');
}

/** Read-only token contract bound to a provider. */
export function tokenContract(
  provider: JsonRpcProvider | WebSocketProvider,
  asset: Asset = defaultAsset(),
): Contract {
  return new Contract(asset.contract, USDT_ABI, provider);
}

/** Token contract bound to a signer (for transfer()). */
export function tokenWithSigner(
  wallet: Wallet,
  asset: Asset = defaultAsset(),
): Contract {
  return new Contract(asset.contract, USDT_ABI, wallet);
}

/** Human string -> base-unit BigInt, scaled by THIS asset's decimals. */
export function toBaseUnits(amount: string, asset: Asset = defaultAsset()): bigint {
  return parseUnits(amount, asset.decimals);
}

/** Base-unit BigInt -> human string, scaled by THIS asset's decimals. */
export function fromBaseUnits(amount: bigint, asset: Asset = defaultAsset()): string {
  return formatUnits(amount, asset.decimals);
}

// ---------------------------------------------------------------------------
// Back-compat aliases. Every existing call site said "usdt"; keeping these means
// the multi-asset change does not have to touch code that genuinely only ever
// deals with USDT (recover.ts, one-off scripts).
// ---------------------------------------------------------------------------
export const usdtContract = tokenContract;
export const usdtWithSigner = tokenWithSigner;
