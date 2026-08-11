/**
 * Commission management + split computation.
 *
 * Commissions are versioned: setting a new one deactivates the previous active row
 * and inserts a fresh row (full audit trail), all in one transaction. computeSplit
 * derives {commissionAmount, networkFee, netAmount} for a settlement, respecting
 * the fee_payer (client vs admin) rule.
 *
 * Three commission modes:
 *   - 'fixed'      : a flat fee per payment, in the commission's OWN asset.
 *   - 'percentage' : value% of the gross.
 *   - 'tiered'     : slab-based — the gross falls into ONE slab (by amount range)
 *                    and that slab's fixed/percentage rate applies to the WHOLE
 *                    gross (not marginal). Example slabs:
 *                      0    – 10    -> fixed 1 USDT
 *                      10   – 1000  -> 1% of amount
 *                      1000 – ∞     -> 0.5% of amount
 *
 * ===================== A COMMISSION HAS A DENOMINATION ======================
 * Every number in a commission that is an AMOUNT rather than a RATE — the
 * `fixed` value, a fixed tier's value, and every tier BOUND — is money, and
 * money here is never just a number: it is (network, asset). The table used to
 * carry no asset at all while the schema comment said "fixed USDT", so a
 * commission written as "1" meaning one dollar was applied verbatim to whatever
 * asset the payment happened to be in. A 0.05 BTC payment fell into the
 * "0 – 10, small payment" slab, took a `fixed 1` fee meaning ONE BITCOIN, and
 * the old clamp below quietly cut it back to 100% of the gross — so the merchant
 * was never paid and the whole deposit read as legitimate operator commission.
 *
 * So commissions now carry `asset` (and optionally `network`), and computeSplit
 * REFUSES to apply an amount-denominated commission to a settlement in a
 * different asset rather than reinterpreting the number. PERCENTAGE rates are
 * genuinely asset-agnostic — 1% of a gross is 1% whatever the gross is in — and
 * are left unscoped, which is why the signup default keeps working untouched.
 *
 * Money precision: all arithmetic is done in BigInt at the ledger's fixed
 * accounting scale (utils/money.ts), never at any chain's on-chain decimals —
 * this file used to scale by the BEP20 USDT asset, so a deployment that
 * overrode USDT_DECIMALS silently re-scaled every commission it computed.
 */
import { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import {
  ACCOUNTING_DECIMALS,
  fromAccountingUnits,
  toAccountingUnits,
} from '../utils/money';
import { DEFAULT_ASSET, enabledAssets } from '../blockchain/assets';
import { Network, parseNetwork } from '../blockchain/networks';
import { writeAudit } from './auditService';
import { AppError } from '../utils/apiError';

export type CommissionType = 'percentage' | 'fixed' | 'tiered';
export type FeePayer = 'client' | 'admin';

/** 10^ACCOUNTING_DECIMALS, as a BigInt — the scale every amount below is in. */
const ACCOUNTING_SCALE = 10n ** BigInt(ACCOUNTING_DECIMALS);

/**
 * One slab of a tiered commission.
 *
 * Bounds are AMOUNTS in the commission's `asset`, not abstract numbers. That is
 * what makes a tiered commission denominated even when every slab is a
 * percentage: a 0.05 BTC payment worth $5,000 lands in a "0 – 10" slab meant for
 * small payments unless the bounds and the settlement agree on the asset.
 */
export interface CommissionTier {
  minAmount: string; // inclusive lower bound
  maxAmount: string | null; // inclusive upper bound; null = unbounded (last slab only)
  type: 'fixed' | 'percentage';
  value: string; // fixed fee in the commission's asset, or percent (e.g. "1" = 1%)
}

export interface CommissionRow {
  id: string;
  client_id: string;
  type: CommissionType;
  value: string; // NUMERIC as string (0 when tiered)
  tiers: CommissionTier[] | null; // populated when type = 'tiered'
  network_fee_payer: FeePayer;
  /**
   * Denomination of every AMOUNT in this row (migration 015). NULL means
   * "no denomination", which is only meaningful for a pure percentage rate.
   */
  asset: string | null;
  /** Chain this commission applies to. NULL = every chain. */
  network: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

/**
 * The active commission for a client, optionally scoped to the settlement it is
 * about to be applied to.
 *
 * NETWORK IS A FILTER. A row that names a chain is a statement that it applies
 * to that chain and no other, so a TRC20 settlement never picks up a BEP20 rate;
 * it falls through to the client-wide row, or to nothing if the operator has
 * genuinely said nothing about that chain.
 *
 * ASSET IS A PREFERENCE, NOT A FILTER, and the distinction is load-bearing.
 * Migration 015 backfills `asset = 'USDT'` onto every pre-existing fixed/tiered
 * row, because that is what those numbers always meant. Filtering on asset would
 * make a BNB settlement match nothing and charge ZERO commission — a silent
 * revenue leak, and worse, an operator would never learn their configuration is
 * incomplete. So a mismatched row is still returned, ranked last, and
 * computeSplit refuses it loudly. Ranking:
 *
 *   0. the asset matches exactly            -> the fee was written for this asset
 *   1. the row carries no asset             -> a pure rate; correct on anything
 *   2. the asset differs                    -> surfaced, then rejected loudly
 *
 * with a chain-specific row beating a client-wide one, and the newest winning
 * within a rank (the pre-existing versioning behaviour).
 */
export async function getActiveCommission(
  clientId: string,
  network?: string | null,
  asset?: string | null,
): Promise<CommissionRow | null> {
  const scopeNetwork = network ? String(network).toUpperCase() : null;
  const scopeAsset = asset ? String(asset).toUpperCase() : null;
  const rows = await query<CommissionRow>(
    `SELECT * FROM commissions
      WHERE client_id = $1 AND is_active = true
        AND (network IS NULL OR network = $2)
      ORDER BY CASE
                 WHEN asset = $3    THEN 0
                 WHEN asset IS NULL THEN 1
                 ELSE 2
               END,
               (network IS NOT NULL) DESC,
               -- created_at is transaction START time and two commission rows for
               -- one client can share it to the microsecond. Without a total
               -- order the winner of a tie is whatever the plan happens to emit
               -- first, i.e. the rate a merchant is charged could differ between
               -- two reads of the same data. id is unique, so this makes the
               -- pick deterministic; it costs nothing and decides nothing else.
               created_at DESC, id DESC
      LIMIT 1`,
    [clientId, scopeNetwork, scopeAsset],
  );
  return rows[0] ?? null;
}

// --------------------------------------------------------------------------
// Tier validation + normalisation
// --------------------------------------------------------------------------

/**
 * Validate + normalise (sort ascending) a set of tiers. Rules:
 *  - at least one tier;
 *  - each: value >= 0, minAmount >= 0, maxAmount null or > minAmount;
 *  - sorted by minAmount, no overlaps (next.min >= prev.max — shared boundary OK);
 *  - only the LAST tier may have maxAmount = null (unbounded tail).
 * Returns the sorted tiers or throws AppError.badRequest.
 */
export function validateTiers(tiers: CommissionTier[]): CommissionTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw AppError.badRequest('tiered commission requires at least one tier');
  }

  const norm = tiers.map((t, i) => {
    if (t.type !== 'fixed' && t.type !== 'percentage') {
      throw AppError.badRequest(`tier ${i}: type must be fixed or percentage`);
    }
    const min = Number(t.minAmount);
    const max = t.maxAmount === null || t.maxAmount === undefined ? null : Number(t.maxAmount);
    const val = Number(t.value);
    if (Number.isNaN(min) || min < 0) {
      throw AppError.badRequest(`tier ${i}: minAmount must be a number >= 0`);
    }
    if (max !== null && (Number.isNaN(max) || max <= min)) {
      throw AppError.badRequest(`tier ${i}: maxAmount must be > minAmount (or null)`);
    }
    if (Number.isNaN(val) || val < 0) {
      throw AppError.badRequest(`tier ${i}: value must be a number >= 0`);
    }
    if (t.type === 'percentage' && val > 100) {
      throw AppError.badRequest(`tier ${i}: percentage value cannot exceed 100`);
    }
    return {
      minAmount: String(t.minAmount),
      maxAmount: max === null ? null : String(t.maxAmount),
      type: t.type,
      value: String(t.value),
    };
  });

  norm.sort((a, b) => Number(a.minAmount) - Number(b.minAmount));

  for (let i = 0; i < norm.length; i++) {
    const isLast = i === norm.length - 1;
    if (norm[i].maxAmount === null && !isLast) {
      throw AppError.badRequest('only the last tier may have an unbounded (null) maxAmount');
    }
    if (i > 0) {
      const prevMax = norm[i - 1].maxAmount;
      if (prevMax === null) {
        throw AppError.badRequest('unbounded tier must be last');
      }
      if (Number(norm[i].minAmount) < Number(prevMax)) {
        throw AppError.badRequest('tiers must not overlap (next minAmount >= previous maxAmount)');
      }
    }
  }
  return norm;
}

/**
 * Pick the slab whose [min, max] range contains grossU (accounting units). First
 * match wins. Only sound once the caller has established that the bounds and the
 * gross are denominated in the same asset — see assertDenomination.
 */
function pickTier(tiers: CommissionTier[], grossU: bigint): CommissionTier | null {
  for (const t of tiers) {
    const minU = toAccountingUnits(t.minAmount);
    const maxU = t.maxAmount === null ? null : toAccountingUnits(t.maxAmount);
    if (grossU >= minU && (maxU === null || grossU <= maxU)) return t;
  }
  return null;
}

// --------------------------------------------------------------------------
// Denomination
// --------------------------------------------------------------------------

/**
 * Does this commission contain AMOUNTS (as opposed to only rates)?
 *
 * 'fixed' obviously does. 'tiered' does too even when every slab is a
 * percentage, because the slab BOUNDS are amounts and picking the wrong slab is
 * the same class of error as charging the wrong fee.
 */
function isAmountDenominated(commission: Pick<CommissionRow, 'type'>): boolean {
  return commission.type === 'fixed' || commission.type === 'tiered';
}

/**
 * The asset an amount-denominated commission is expressed in.
 *
 * NULL falls back to USDT rather than to "whatever is being settled": that is
 * what the column meant before it existed (schema.sql said `fixed USDT`, and so
 * did this file's own interface comment), so reading a legacy row as USDT
 * preserves the intent that was actually configured. Migration 015 backfills the
 * same value, so this is a belt-and-braces for rows written before it ran.
 */
function denominationOf(commission: Pick<CommissionRow, 'asset'>): string {
  return (commission.asset ?? DEFAULT_ASSET).toUpperCase();
}

/** Every symbol this deployment can settle, for error messages and validation. */
function knownSymbols(): string[] {
  return Array.from(new Set(enabledAssets().map((a) => a.symbol))).sort();
}

// --------------------------------------------------------------------------
// setCommission
// --------------------------------------------------------------------------

export interface SetCommissionInput {
  clientId: string;
  type: CommissionType;
  value?: string; // required for flat (percentage|fixed); ignored when tiered
  tiers?: CommissionTier[]; // required when type = 'tiered'
  networkFeePayer: FeePayer;
  /**
   * Denomination of the amounts in this commission (fixed value, tier bounds).
   * Omitted on an amount-denominated commission -> USDT, which is what the
   * column meant before it existed. Ignored for a pure percentage rate.
   */
  asset?: string | null;
  /** Restrict this commission to one chain. Omitted -> applies to every chain. */
  network?: string | null;
  createdByUserId: string;
  note?: string | null;
  ip?: string | null;
}

export async function setCommission(
  input: SetCommissionInput,
): Promise<CommissionRow> {
  if (!['percentage', 'fixed', 'tiered'].includes(input.type)) {
    throw AppError.badRequest('type must be percentage, fixed or tiered');
  }
  if (!['client', 'admin'].includes(input.networkFeePayer)) {
    throw AppError.badRequest('networkFeePayer must be client or admin');
  }

  let storedValue = '0';
  let storedTiers: CommissionTier[] | null = null;

  if (input.type === 'tiered') {
    storedTiers = validateTiers(input.tiers ?? []);
  } else {
    if (input.value === undefined || Number.isNaN(Number(input.value)) || Number(input.value) < 0) {
      throw AppError.badRequest('value must be a non-negative number');
    }
    if (input.type === 'percentage' && Number(input.value) > 100) {
      throw AppError.badRequest('percentage value cannot exceed 100');
    }
    storedValue = input.value;
  }

  // ---- Resolve the scope this commission is written at ----------------------
  //
  // The denomination is decided HERE, at configuration time, rather than at
  // payout time. An operator typing "1" into a fixed-fee box is stating an
  // amount of something; if we do not capture what, the only place left to guess
  // is the settlement itself, and guessing there charged a whole BNB for a fee
  // that meant a dollar.
  const scopeGiven = input.network !== undefined || input.asset !== undefined;
  const storedNetwork: Network | null = input.network
    ? parseNetwork(input.network)
    : null;

  let storedAsset: string | null = null;
  if (input.asset) {
    const wanted = String(input.asset).toUpperCase();
    const symbols = knownSymbols();
    if (!symbols.includes(wanted)) {
      throw AppError.badRequest(
        `Commission asset "${input.asset}" is not settled by this deployment. ` +
          `Known assets: ${symbols.join(', ') || 'none'}.`,
      );
    }
    if (storedNetwork && !enabledAssets().some((a) => a.network === storedNetwork && a.symbol === wanted)) {
      throw AppError.badRequest(
        `Asset "${wanted}" is not available on ${storedNetwork}`,
      );
    }
    storedAsset = wanted;
  } else if (isAmountDenominated({ type: input.type })) {
    // No asset named for a commission that carries amounts. Record the
    // historical meaning explicitly — USDT — instead of leaving the row
    // denomination-less and letting computeSplit infer one later. Note this is
    // NOT a claim that USDT is enabled here; it is what the operator's number
    // has always meant, and it is now checkable against the settlement.
    storedAsset = DEFAULT_ASSET;
  }

  return withTransaction(async (client: PoolClient) => {
    // FOR UPDATE — this is the serialisation point for "one active commission per
    // scope", not just an existence check.
    //
    // The deactivate-then-insert pair below is read-modify-write, and
    // withTransaction issues a bare BEGIN, i.e. READ COMMITTED. Two operators
    // saving a commission for the same client at once interleaved like this:
    // T2's UPDATE blocked on T1's row lock over the pre-existing active row, and
    // when T1 committed, T2 re-evaluated and found is_active already false —
    // while T1's newly INSERTED row was invisible to T2's already-started
    // statement. T2 then inserted its own, leaving TWO active rows in one scope.
    // getActiveCommission's ORDER BY then picks one of them deterministically
    // forever, which may not be the one the operator who saved last was shown.
    //
    // Locking the CLIENT row makes the pair atomic per client: the second
    // transaction waits here, before it reads anything about commissions, and
    // therefore sees the first one's insert. The lock is held only for this
    // short transaction and setCommission is a rare, human-driven admin action,
    // so there is nothing to queue behind it.
    const exists = await client.query(
      `SELECT 1 FROM clients WHERE id = $1 FOR UPDATE`,
      [input.clientId],
    );
    if (exists.rowCount === 0) {
      throw AppError.notFound('Client not found');
    }

    // Versioning is per SCOPE once a caller names one: replacing the BEP20/BNB
    // rate must not silently retire the client-wide rate that every other asset
    // settles on. A caller that names no scope is the pre-existing "this is the
    // client's commission" gesture, and still supersedes everything — otherwise
    // switching a client from a fixed fee to a percentage would leave the old
    // fixed row alive and winning for its own asset.
    if (scopeGiven) {
      await client.query(
        `UPDATE commissions SET is_active = false
          WHERE client_id = $1 AND is_active = true
            AND network IS NOT DISTINCT FROM $2
            AND asset   IS NOT DISTINCT FROM $3`,
        [input.clientId, storedNetwork, storedAsset],
      );
    } else {
      await client.query(
        `UPDATE commissions SET is_active = false
          WHERE client_id = $1 AND is_active = true`,
        [input.clientId],
      );
    }

    let res;
    try {
      res = await client.query<CommissionRow>(
        `INSERT INTO commissions
           (client_id, type, value, tiers, network_fee_payer, asset, network,
            is_active, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, true, $8)
         RETURNING *`,
        [
          input.clientId,
          input.type,
          storedValue,
          storedTiers ? JSON.stringify(storedTiers) : null,
          input.networkFeePayer,
          storedAsset,
          storedNetwork,
          input.createdByUserId,
        ],
      );
    } catch (err) {
      // uq_commissions_one_active (migration 026, if applied): at most one active
      // row per (client_id, network, asset). The row lock above already prevents
      // the race that produced a second one, so this is the backstop telling an
      // operator something changed under them rather than letting apiError.ts map
      // a raw 23505 to the generic 'Resource already exists'.
      if ((err as { code?: string } | null)?.code === '23505') {
        throw AppError.conflict(
          "This client's commission was changed concurrently. Reload and try again.",
        );
      }
      throw err;
    }
    const row = res.rows[0];

    await writeAudit(
      {
        actorUserId: input.createdByUserId,
        action: 'commission.update',
        entityType: 'client',
        entityId: input.clientId,
        metadata: {
          type: input.type,
          value: storedValue,
          tiers: storedTiers,
          network_fee_payer: input.networkFeePayer,
          asset: storedAsset,
          network: storedNetwork,
          commission_id: row.id,
          ...(input.note ? { note: input.note } : {}),
        },
        ip: input.ip ?? null,
      },
      client,
    );

    return row;
  });
}

// --------------------------------------------------------------------------
// computeSplit
// --------------------------------------------------------------------------

export interface Split {
  commissionAmount: string;
  networkFee: string;
  netAmount: string;
}

/** Apply a fixed/percentage rate to a gross (accounting units). */
function applyRate(grossU: bigint, type: 'fixed' | 'percentage', value: string): bigint {
  if (type === 'percentage') {
    const valueScaled = toAccountingUnits(value); // value * 10^ACCOUNTING_DECIMALS
    return (grossU * valueScaled) / (100n * ACCOUNTING_SCALE);
  }
  // A flat fee, already an amount — in the COMMISSION's asset, which the caller
  // has established is the settlement asset.
  return toAccountingUnits(value);
}

/**
 * Refuse to apply an amount-denominated commission to a settlement in another
 * asset.
 *
 * This is the guard, and it deliberately throws rather than converting. There is
 * no price oracle in this gateway and there is no honest way to turn "1 USDT"
 * into an amount of BNB at settlement time; the previous behaviour — treat the
 * number as if it were already in the settlement asset — is exactly how a
 * one-dollar fee became one Bitcoin. A thrown payout is recoverable by fixing
 * the configuration; a 100% fee that reads as legitimate commission is not.
 */
function assertDenomination(
  commission: Pick<CommissionRow, 'type' | 'asset'>,
  settlementAsset: string | null | undefined,
): void {
  if (!isAmountDenominated(commission)) return; // a rate is asset-agnostic
  if (!settlementAsset) return; // caller could not name it — see computeSplit
  const declared = denominationOf(commission);
  const settling = String(settlementAsset).toUpperCase();
  if (declared === settling) return;
  throw AppError.badRequest(
    `Commission is denominated in ${declared} but this settlement is in ${settling}. ` +
      `A ${commission.type} commission carries amounts, and amounts do not cross assets — ` +
      `configure a ${settling} commission for this client, or use a percentage rate ` +
      `(percentages apply to any asset).`,
  );
}

/**
 * Compute the settlement split for a gross received amount.
 *
 * - commission: 'percentage' of gross, a 'fixed' amount in the commission's own
 *   asset, or 'tiered' (the matching slab's rate applied to the whole gross).
 * - networkFee: on-chain sweep/payout cost, passed as a string.
 * - settlementAsset: the asset `gross` is in. Pass it whenever it is known —
 *   without it an amount-denominated commission cannot be checked against the
 *   settlement, and the only protection left is the exceeds-gross guard below,
 *   which catches a fee bigger than the payment but not a 1-BTC fee on a 5-BTC
 *   one. Optional only so callers can be threaded through one at a time.
 * - fee_payer:
 *     'client' -> networkFee deducted from the client's net.
 *     'admin'  -> admin absorbs networkFee; client's net = gross - commission.
 *
 * netAmount is clamped at >= 0. All arithmetic is at the ledger accounting
 * scale, which holds every asset in the registry losslessly.
 */
export function computeSplit(
  gross: string,
  commission:
    | Pick<CommissionRow, 'type' | 'value' | 'tiers' | 'network_fee_payer' | 'asset'>
    | null,
  networkFee: string,
  settlementAsset?: string | null,
): Split {
  const grossU = toAccountingUnits(gross);
  const feeU = toAccountingUnits(networkFee || '0');

  let commissionU = 0n;
  if (commission) {
    assertDenomination(commission, settlementAsset);
    if (commission.type === 'tiered' && commission.tiers && commission.tiers.length > 0) {
      const tier = pickTier(commission.tiers, grossU);
      if (tier) commissionU = applyRate(grossU, tier.type, tier.value);
    } else if (commission.type === 'percentage' || commission.type === 'fixed') {
      commissionU = applyRate(grossU, commission.type, commission.value);
    }
  }

  // A commission larger than the gross it is taken from is never a real fee —
  // a percentage cannot reach here (values are capped at 100), so this is always
  // a flat amount read in the wrong denomination. It used to be CLAMPED to the
  // gross, which turned a configuration error into a silent 100% fee: the
  // merchant's whole deposit stayed in the central wallet and, with no payout
  // row to offset it, was counted as withdrawable operator commission. Fail
  // loudly instead. The payout is not created either way — the caller already
  // rejected the zero net that the clamp produced — so nothing that used to
  // settle stops settling; it just says what is actually wrong.
  if (commissionU > grossU) {
    throw AppError.badRequest(
      `Commission ${fromAccountingUnits(commissionU)} exceeds the gross ${gross}` +
        (commission ? ` (commission is denominated in ${denominationOf(commission)})` : '') +
        ` — the commission is configured in a different denomination than the settlement asset.`,
    );
  }

  const feePayer: FeePayer = commission?.network_fee_payer ?? 'client';
  let netU = grossU - commissionU;
  if (feePayer === 'client') {
    netU -= feeU;
  }
  if (netU < 0n) netU = 0n;

  return {
    commissionAmount: fromAccountingUnits(commissionU),
    networkFee: fromAccountingUnits(feeU),
    netAmount: fromAccountingUnits(netU),
  };
}
