/**
 * Commission management + split computation.
 *
 * Commissions are versioned: setting a new one deactivates the previous active row
 * and inserts a fresh row (full audit trail), all in one transaction. computeSplit
 * derives {commissionAmount, networkFee, netAmount} for a settlement, respecting
 * the fee_payer (client vs admin) rule.
 *
 * Three commission modes:
 *   - 'fixed'      : a flat USDT fee per payment.
 *   - 'percentage' : value% of the gross.
 *   - 'tiered'     : slab-based — the gross falls into ONE slab (by amount range)
 *                    and that slab's fixed/percentage rate applies to the WHOLE
 *                    gross (not marginal). Example slabs:
 *                      0    – 10    -> fixed 1 USDT
 *                      10   – 1000  -> 1% of amount
 *                      1000 – ∞     -> 0.5% of amount
 *
 * Money precision: all arithmetic is done in BigInt base units (18 decimals) to
 * avoid floating-point drift, then formatted back to NUMERIC(38,18) strings.
 */
import { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool';
import { fromBaseUnits, toBaseUnits } from '../blockchain/usdt';
import { writeAudit } from './auditService';
import { AppError } from '../utils/apiError';

export type CommissionType = 'percentage' | 'fixed' | 'tiered';
export type FeePayer = 'client' | 'admin';

/** One slab of a tiered commission. Bounds are in USDT (decimal strings). */
export interface CommissionTier {
  minAmount: string; // inclusive lower bound
  maxAmount: string | null; // inclusive upper bound; null = unbounded (last slab only)
  type: 'fixed' | 'percentage';
  value: string; // fixed USDT fee, or percent (e.g. "1" = 1%)
}

export interface CommissionRow {
  id: string;
  client_id: string;
  type: CommissionType;
  value: string; // NUMERIC as string (0 when tiered)
  tiers: CommissionTier[] | null; // populated when type = 'tiered'
  network_fee_payer: FeePayer;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
}

export async function getActiveCommission(
  clientId: string,
): Promise<CommissionRow | null> {
  const rows = await query<CommissionRow>(
    `SELECT * FROM commissions
      WHERE client_id = $1 AND is_active = true
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientId],
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

/** Pick the slab whose [min, max] range contains grossU (base units). First match wins. */
function pickTier(tiers: CommissionTier[], grossU: bigint): CommissionTier | null {
  for (const t of tiers) {
    const minU = toBaseUnits(t.minAmount);
    const maxU = t.maxAmount === null ? null : toBaseUnits(t.maxAmount);
    if (grossU >= minU && (maxU === null || grossU <= maxU)) return t;
  }
  return null;
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

  return withTransaction(async (client: PoolClient) => {
    const exists = await client.query(`SELECT 1 FROM clients WHERE id = $1`, [
      input.clientId,
    ]);
    if (exists.rowCount === 0) {
      throw AppError.notFound('Client not found');
    }

    await client.query(
      `UPDATE commissions SET is_active = false
        WHERE client_id = $1 AND is_active = true`,
      [input.clientId],
    );

    const res = await client.query<CommissionRow>(
      `INSERT INTO commissions
         (client_id, type, value, tiers, network_fee_payer, is_active, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, true, $6)
       RETURNING *`,
      [
        input.clientId,
        input.type,
        storedValue,
        storedTiers ? JSON.stringify(storedTiers) : null,
        input.networkFeePayer,
        input.createdByUserId,
      ],
    );
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

/** Apply a fixed/percentage rate to a gross (base units). */
function applyRate(grossU: bigint, type: 'fixed' | 'percentage', value: string): bigint {
  if (type === 'percentage') {
    const valueScaled = toBaseUnits(value); // value * 1e18
    return (grossU * valueScaled) / (100n * 10n ** 18n);
  }
  return toBaseUnits(value); // fixed USDT
}

/**
 * Compute the settlement split for a gross received amount.
 *
 * - commission: 'percentage' of gross, a 'fixed' USDT amount, or 'tiered' (the
 *   matching slab's rate applied to the whole gross).
 * - networkFee: on-chain sweep/payout cost, passed as a string.
 * - fee_payer:
 *     'client' -> networkFee deducted from the client's net.
 *     'admin'  -> admin absorbs networkFee; client's net = gross - commission.
 *
 * netAmount is clamped at >= 0.
 */
export function computeSplit(
  gross: string,
  commission: Pick<CommissionRow, 'type' | 'value' | 'tiers' | 'network_fee_payer'> | null,
  networkFee: string,
): Split {
  const grossU = toBaseUnits(gross);
  const feeU = toBaseUnits(networkFee || '0');

  let commissionU = 0n;
  if (commission) {
    if (commission.type === 'tiered' && commission.tiers && commission.tiers.length > 0) {
      const tier = pickTier(commission.tiers, grossU);
      if (tier) commissionU = applyRate(grossU, tier.type, tier.value);
    } else if (commission.type === 'percentage' || commission.type === 'fixed') {
      commissionU = applyRate(grossU, commission.type, commission.value);
    }
  }
  if (commissionU > grossU) commissionU = grossU;

  const feePayer: FeePayer = commission?.network_fee_payer ?? 'client';
  let netU = grossU - commissionU;
  if (feePayer === 'client') {
    netU -= feeU;
  }
  if (netU < 0n) netU = 0n;

  return {
    commissionAmount: fromBaseUnits(commissionU),
    networkFee: fromBaseUnits(feeU),
    netAmount: fromBaseUnits(netU),
  };
}
