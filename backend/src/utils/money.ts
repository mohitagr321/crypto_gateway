/**
 * Internal accounting money math (network-independent).
 *
 * WHY THIS EXISTS
 * ---------------
 * USDT does not have the same number of decimals on every chain:
 *   BEP20 (BSC)  -> 18 decimals
 *   TRC20 (Tron) ->  6 decimals
 *
 * On-chain amounts MUST be scaled with the decimals of the chain they belong to
 * (see each ChainAdapter's toBaseUnits/fromBaseUnits). But ledger arithmetic —
 * balances, commission splits, payout guards — sums values that may come from
 * BOTH chains, so it must use ONE fixed scale that is a property of the ledger,
 * not of any chain.
 *
 * That fixed scale is ACCOUNTING_DECIMALS (18). It is deliberately a constant and
 * NOT read from env: it is an internal representation, never an on-chain value.
 * Because every conversion is symmetric (human -> units -> human), the choice is
 * lossless for both chains — 18 dp comfortably holds TRC20's 6 dp and BEP20's 18.
 *
 * NEVER pass a value produced by these helpers to a contract call, and never pass
 * a chain's base units into these helpers.
 */
import { formatUnits, parseUnits } from 'ethers';

/** Fixed internal fixed-point scale for all ledger arithmetic. Not chain-specific. */
export const ACCOUNTING_DECIMALS = 18;

/** Human string -> internal accounting BigInt (e.g. "50.0" -> 50e18). */
export function toAccountingUnits(amount: string): bigint {
  return parseUnits(amount || '0', ACCOUNTING_DECIMALS);
}

/** Internal accounting BigInt -> human string (e.g. 50e18 -> "50.0"). */
export function fromAccountingUnits(amount: bigint): string {
  return formatUnits(amount, ACCOUNTING_DECIMALS);
}
