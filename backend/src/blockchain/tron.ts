/**
 * Tron / TRC20 client wiring (tronweb v6).
 *
 * Kept separate from tronAdapter.ts so the listener and the adapter share one
 * client construction path and one set of unit helpers.
 *
 * DECIMALS: USDT on Tron has 6 decimals (config.tron.usdtDecimals), NOT the 18
 * that BSC uses. Every conversion in this file is scaled by the Tron value. Never
 * mix these helpers with blockchain/usdt.ts's (18 dp) or utils/money.ts's
 * (accounting) helpers — see utils/money.ts for why the three are separate.
 *
 * FEES: Tron has no gas price. A TRC20 transfer consumes *energy* and *bandwidth*.
 * An account with neither staked burns TRX instead (~13-30 TRX for a USDT
 * transfer, depending on whether the recipient already holds USDT). `feeLimit` is
 * a hard ceiling on that burn, not an estimate.
 */
import { TronWeb } from 'tronweb';
import { formatUnits, parseUnits } from 'ethers';
import { config } from '../config/env';

/** Minimal TRC20 ABI — the same surface the BEP20 side uses. */
export const TRC20_ABI = [
  {
    constant: true,
    inputs: [{ name: 'who', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'View',
    type: 'Function',
  },
  {
    constant: false,
    inputs: [
      { name: '_to', type: 'address' },
      { name: '_value', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'Nonpayable',
    type: 'Function',
  },
] as const;

// 1 TRX = 1e6 sun — the same scale as TRC20 USDT, which is why both use 6 here.
export function trxToSun(trx: string): bigint {
  return parseUnits(trx || '0', 6);
}

export function sunToTrx(sun: bigint): string {
  return formatUnits(sun, 6);
}

/**
 * Human string -> TRC20 base units, scaled by THIS asset's decimals.
 *
 * Tron stablecoins are NOT uniformly 6 dp — USDT and USDC are, but USDD is 18.
 * Defaulting to USDT keeps every pre-multi-asset call site unchanged; anything
 * touching another token must pass its asset or it will mis-scale by 10^12.
 */
export function toTronBaseUnits(amount: string, decimals?: number): bigint {
  return parseUnits(amount || '0', decimals ?? config.tron.usdtDecimals);
}

/** TRC20 base units -> human string, scaled by THIS asset's decimals. */
export function fromTronBaseUnits(amount: bigint, decimals?: number): string {
  return formatUnits(amount, decimals ?? config.tron.usdtDecimals);
}

/** Fee ceiling for a TRC20 transfer, in sun (tronweb's feeLimit unit). */
export function feeLimitSun(): number {
  return Number(trxToSun(config.tron.feeLimitTrx));
}

/** tronweb returns BigNumber-ish / string / bigint depending on the call. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (value && typeof (value as { toString?: unknown }).toString === 'function') {
    // BigNumber#toString() gives a plain base-10 integer string for uint256.
    return BigInt((value as { toString(): string }).toString());
  }
  return 0n;
}

/**
 * Placeholder `owner_address` for read-only constant calls.
 *
 * Tron's `triggerConstantContract` REQUIRES an owner_address even for a pure
 * view call — unlike an EVM `eth_call`, which happily accepts no `from`. A
 * TronWeb instance built without a private key has no default address, so every
 * `.call()` on it fails with "owner_address isn't set". That would break
 * balanceOf reads and, critically, the sweep (which reads the deposit balance
 * before transferring).
 *
 * This is the well-known Tron blackhole address. It is never signed with and
 * needs no funds — it only satisfies the node's parameter check.
 */
const READONLY_OWNER_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

/**
 * Build a TronWeb client. Pass a private key to get a signing client.
 *
 * A fresh instance per signer keeps signing state immutable and avoids the
 * classic tronweb footgun of mutating a shared client's key mid-flight (which
 * under concurrency signs a transaction with the wrong wallet).
 *
 * Without a key the client is read-only and gets the placeholder owner address
 * above, so constant calls work. Setting it does NOT grant any signing ability.
 */
export function tronClient(privateKey?: string): TronWeb {
  const tw = new TronWeb({
    fullHost: config.tron.fullHost,
    ...(config.tron.apiKey ? { headers: { 'TRON-PRO-API-KEY': config.tron.apiKey } } : {}),
    ...(privateKey ? { privateKey: stripHexPrefix(privateKey) } : {}),
  });
  if (!privateKey) tw.setAddress(READONLY_OWNER_ADDRESS);
  return tw;
}

/** tronweb wants bare hex private keys; ethers/tronweb derivation emits 0x-prefixed. */
export function stripHexPrefix(key: string): string {
  return key.replace(/^0x/, '');
}

/** True if `address` is a well-formed base58 Tron address (rejects 0x/EVM). */
export function isTronAddress(address: string): boolean {
  return typeof address === 'string' && TronWeb.isAddress(address);
}

/** The address controlled by a Tron private key. */
export function tronAddressFromKey(privateKey: string): string {
  return TronWeb.address.fromPrivateKey(stripHexPrefix(privateKey)) as string;
}

/**
 * Convert Tron's hex address form (`41…`, 42 chars) to base58 (`T…`).
 *
 * TronGrid's transaction endpoints return raw hex addresses inside
 * `raw_data.contract[].parameter.value`, while every address this system stores
 * and compares is base58. Comparing the two forms directly always fails, which
 * would silently mean "no deposit matched" for every native transfer.
 *
 * Returns the input unchanged when it is already base58, so callers can pass
 * either form.
 */
export function tronAddressFromHex(hexAddress: string): string {
  if (!hexAddress) return '';
  if (hexAddress.startsWith('T')) return isTronAddress(hexAddress) ? hexAddress : '';
  try {
    const converted = TronWeb.address.fromHex(hexAddress) as string;
    // fromHex does NOT throw on unparseable input — it hands the string back
    // unchanged. Without this check that garbage would flow onward as if it were
    // an address, so validate the RESULT rather than trusting the call.
    return isTronAddress(converted) ? converted : '';
  } catch {
    return '';
  }
}

/**
 * Bandwidth a plain TRX transfer consumes, in bytes (approximate but stable).
 *
 * A TransferContract transaction is ~270 bytes on the wire. Every account gets
 * a free daily bandwidth allowance (600 bytes at the time of writing), so a
 * fresh deposit address can usually send TRX for FREE — which is why the native
 * sweep measures the allowance instead of blindly reserving a fixed amount.
 */
export const TRX_TRANSFER_BANDWIDTH_BYTES = 300;
