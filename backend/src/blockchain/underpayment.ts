/**
 * ONE definition of "how much counts as fully paid".
 *
 * A customer who pays a 50 USDT invoice from an exchange delivers 49.99: the
 * withdrawal fee comes out of the amount they entered. Compared exactly, that
 * invoice can never be satisfied — it sits at `partial` until it expires, the
 * merchant is never paid, and the funds have to be recovered from the deposit
 * address by hand. UNDERPAYMENT_TOLERANCE_PERCENT is the allowance for exactly
 * that: a shortfall within it settles as if it were paid in full.
 *
 * The merchant is credited what ACTUALLY ARRIVED, never the invoiced figure.
 * Both settlement paths move the on-chain balance rather than `amount`, so a
 * tolerated shortfall is absorbed by the merchant — the gateway never invents
 * the difference.
 *
 * ===================== WHY THIS IS A SHARED FRAGMENT ========================
 * The threshold is applied TWICE per listener — once in the SELECT that decides
 * `fully_paid`, and once inside the UPDATE that freezes a payment as `partial`,
 * which re-tests it to avoid losing a race with a concurrent top-up. Those two
 * must agree exactly: a SELECT that says "underpaid" and an UPDATE whose guard
 * disagrees would either freeze a paid invoice or spin re-selecting the same
 * row forever. Three listeners x two sites is six chances to let them drift,
 * which is why they all read from here instead of writing the comparison out.
 */
import { config } from '../config/env';

/**
 * SQL for the smallest amount that satisfies an invoice, as an expression over
 * `amountExpr` (`p.amount`, `amount`, …).
 *
 * The multiplier is interpolated as a literal rather than bound as a parameter
 * because these queries already take positional parameters that differ per call
 * site, and adding one more to six statements is how the numbering gets wrong.
 * It is safe to interpolate: config/env.ts parses it as a NUMBER and rejects
 * anything outside 0-5 at boot, so it can never carry SQL.
 *
 * At the default of 0 the multiplier is exactly 1 and this is the same
 * comparison the gateway has always made.
 */
export function paidFloorSql(amountExpr: string): string {
  // CREDIT_UNDERPAID_AS_RECEIVED: no floor at all. Every confirmed deposit
  // satisfies its invoice and settles for what arrived, so `partial` never
  // happens and the merchant decides whether the amount is enough. A floor of
  // zero cannot confirm a payment that received nothing: the statements using
  // this only select payments that already have a matured incoming transfer.
  if (config.settlement.creditUnderpaidAsReceived) return '0';
  const m = config.settlement.underpaymentFloorMultiplier;
  if (m === 1) return amountExpr;
  return `(${amountExpr} * ${m})`;
}
