import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { classNames, formatUsdt, formatRate } from '@/lib/format';
import type {
  Commission,
  CommissionTier,
  CommissionType,
  FeePayer,
  SetCommissionInput,
} from '@/types';

// ---------------------------------------------------------------------------
// Draft state used while editing. Kept as strings so inputs stay controlled and
// empty maxAmount => unbounded (null) is preserved as an empty string.
// ---------------------------------------------------------------------------
export interface TierDraft {
  minAmount: string;
  maxAmount: string; // '' === unbounded
  type: 'fixed' | 'percentage';
  value: string;
}

export interface CommissionDraft {
  type: CommissionType;
  value: string;
  feePayer: FeePayer;
  tiers: TierDraft[];
}

const emptyTier = (): TierDraft => ({ minAmount: '', maxAmount: '', type: 'percentage', value: '' });

export function draftFromCommission(commission?: Commission | null): CommissionDraft {
  if (!commission) {
    return { type: 'percentage', value: '', feePayer: 'client', tiers: [emptyTier()] };
  }
  return {
    type: commission.type,
    value: commission.value ?? '',
    feePayer: commission.feePayer ?? 'client',
    tiers:
      commission.tiers && commission.tiers.length
        ? commission.tiers.map((t) => ({
            minAmount: t.minAmount ?? '',
            maxAmount: t.maxAmount == null ? '' : String(t.maxAmount),
            type: t.type,
            value: t.value ?? '',
          }))
        : [emptyTier()],
  };
}

/**
 * Validate a draft and, when valid, build the SetCommissionInput body.
 * Returns either { errors } (keyed for inline display) or { input }.
 */
export function buildCommissionInput(
  clientId: string,
  draft: CommissionDraft,
  note?: string
): { input: SetCommissionInput } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (draft.type !== 'tiered') {
    if (draft.value.trim() === '' || Number.isNaN(Number(draft.value))) {
      errors.value = 'Enter a valid number';
    } else if (Number(draft.value) < 0) {
      errors.value = 'Must be ≥ 0';
    }
    if (Object.keys(errors).length) return { errors };
    return {
      input: {
        clientId,
        type: draft.type,
        value: draft.value,
        feePayer: draft.feePayer,
        note,
      },
    };
  }

  // Tiered validation.
  if (draft.tiers.length === 0) {
    errors.tiers = 'Add at least one tier';
    return { errors };
  }

  let prevMax: number | null = null;
  draft.tiers.forEach((t, i) => {
    const min = Number(t.minAmount);
    const hasMax = t.maxAmount.trim() !== '';
    const max = hasMax ? Number(t.maxAmount) : null;

    if (t.minAmount.trim() === '' || Number.isNaN(min)) {
      errors[`tier.${i}.minAmount`] = 'Required';
    }
    if (hasMax && Number.isNaN(max as number)) {
      errors[`tier.${i}.maxAmount`] = 'Invalid';
    }
    if (t.value.trim() === '' || Number.isNaN(Number(t.value))) {
      errors[`tier.${i}.value`] = 'Required';
    }
    // Only the last tier may be unbounded.
    if (!hasMax && i !== draft.tiers.length - 1) {
      errors[`tier.${i}.maxAmount`] = 'Only the last tier may be unbounded';
    }
    if (hasMax && max != null && !Number.isNaN(min) && max <= min) {
      errors[`tier.${i}.maxAmount`] = 'Max must be greater than min';
    }
    // Ascending / contiguous: each min should match previous max.
    if (i > 0 && prevMax != null && !Number.isNaN(min) && min < prevMax) {
      errors[`tier.${i}.minAmount`] = 'Must be ≥ previous tier max';
    }
    prevMax = max;
  });

  if (Object.keys(errors).length) return { errors };

  const tiers: CommissionTier[] = draft.tiers.map((t) => ({
    minAmount: t.minAmount,
    maxAmount: t.maxAmount.trim() === '' ? null : t.maxAmount,
    type: t.type,
    value: t.value,
  }));

  return {
    input: { clientId, type: 'tiered', tiers, feePayer: draft.feePayer, note },
  };
}

// ---------------------------------------------------------------------------
// Read-only display of the current commission.
// ---------------------------------------------------------------------------
export function CommissionSummary({ commission }: { commission?: Commission | null }) {
  // Never a bare dash: say WHICH nothing this is. An unset commission means the
  // gateway is taking nothing from this merchant, which is a fact worth reading
  // rather than an empty cell.
  if (!commission) {
    return <span className="text-slate-500 dark:text-slate-400">Not set</span>;
  }

  if (commission.type === 'tiered' && commission.tiers?.length) {
    return (
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th className="border-b border-slate-900 py-1.5 pr-4 text-left text-xs font-medium uppercase tracking-[0.18em] text-slate-500 dark:border-slate-100 dark:text-slate-400">
                Range (USDT)
              </th>
              <th className="border-b border-slate-900 py-1.5 text-right text-xs font-medium uppercase tracking-[0.18em] text-slate-500 dark:border-slate-100 dark:text-slate-400">
                Rate
              </th>
            </tr>
          </thead>
          <tbody>
            {commission.tiers.map((t, i) => (
              <tr key={i}>
                <td
                  className={`py-1.5 pr-4 tabular-nums lining-nums text-slate-700 dark:text-slate-300 ${
                    i > 0 ? 'border-t border-slate-200 dark:border-slate-800' : ''
                  }`}
                >
                  {tierRangeLabel(t)}
                </td>
                <td
                  className={`py-1.5 text-right tabular-nums lining-nums text-slate-900 dark:text-slate-100 ${
                    i > 0 ? 'border-t border-slate-200 dark:border-slate-800' : ''
                  }`}
                >
                  {tierRateLabel(t)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <span className="num font-medium text-slate-900 dark:text-slate-100">
      {commission.type === 'percentage'
        ? `${formatRate(commission.value)}%`
        : `${formatUsdt(commission.value)} USDT`}
    </span>
  );
}

function tierRangeLabel(t: CommissionTier): string {
  const min = formatUsdt(t.minAmount);
  if (t.maxAmount == null) return `${min}+`;
  return `${min} – ${formatUsdt(t.maxAmount)}`;
}

function tierRateLabel(t: CommissionTier): string {
  return t.type === 'percentage' ? `${formatRate(t.value)}%` : `$${formatUsdt(t.value)} fixed`;
}

// ---------------------------------------------------------------------------
// The editor form fields (mode selector + single value or tier rows + fee payer).
// Fully controlled: parent owns `draft` and receives changes via `onChange`.
// ---------------------------------------------------------------------------
export default function CommissionEditor({
  draft,
  onChange,
  errors,
  disabled = false,
}: {
  draft: CommissionDraft;
  onChange: (next: CommissionDraft) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}) {
  const err = errors ?? {};
  const set = (patch: Partial<CommissionDraft>) => onChange({ ...draft, ...patch });

  const setTier = (idx: number, patch: Partial<TierDraft>) =>
    set({ tiers: draft.tiers.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });

  const addTier = () => {
    // Chain the new tier's min to the previous tier's max when available.
    const last = draft.tiers[draft.tiers.length - 1];
    const nextMin = last && last.maxAmount.trim() !== '' ? last.maxAmount : '';
    set({ tiers: [...draft.tiers, { minAmount: nextMin, maxAmount: '', type: 'percentage', value: '' }] });
  };

  const removeTier = (idx: number) =>
    set({ tiers: draft.tiers.filter((_, i) => i !== idx) });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Mode</label>
          <select
            className="input"
            disabled={disabled}
            value={draft.type}
            onChange={(e) => set({ type: e.target.value as CommissionType })}
          >
            <option value="percentage">Percentage (%)</option>
            <option value="fixed">Fixed (USDT)</option>
            <option value="tiered">Tiered (slab)</option>
          </select>
        </div>
        <div>
          <label className="label">Fee payer</label>
          <select
            className="input"
            disabled={disabled}
            value={draft.feePayer}
            onChange={(e) => set({ feePayer: e.target.value as FeePayer })}
          >
            <option value="client">Client</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>

      {draft.type !== 'tiered' ? (
        <div>
          <label className="label">Value {draft.type === 'percentage' ? '(%)' : '(USDT)'}</label>
          <input
            className="input"
            disabled={disabled}
            placeholder={draft.type === 'percentage' ? '1.5' : '1.00'}
            value={draft.value}
            onChange={(e) => set({ value: e.target.value })}
          />
          {err.value && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err.value}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {/* The worked example, set as a footnote on a measure rather than
              inside a tinted box. It is the fastest way to explain a slab table
              and it costs one line. */}
          <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Example: 0.1–10 → $1 fixed, 10–1000 → 1%, 1000+ → 0.5%. Leave the last
            tier's Max empty for unbounded (∞).
          </p>

          {err.tiers && <p className="text-xs text-red-600 dark:text-red-400">{err.tiers}</p>}

          {/* The slab table's running heads, over the ledger's ink rule. From
              `sm` up the tiers read as ruled rows under these; below it each
              tier stacks and carries its own field labels. */}
          <div className="hidden gap-2 border-b border-slate-900 pb-1.5 text-xs font-medium uppercase tracking-[0.18em] text-slate-500 sm:grid sm:grid-cols-[1fr_1fr_1fr_1fr_auto] dark:border-slate-100 dark:text-slate-400">
            <span>Min</span>
            <span>Max (∞ if empty)</span>
            <span>Type</span>
            <span>Value</span>
            <span className="w-9" />
          </div>

          {draft.tiers.map((t, i) => {
            const isLast = i === draft.tiers.length - 1;
            return (
              <div
                key={i}
                className={`grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] ${
                  i > 0 ? 'border-t border-slate-200 pt-3 dark:border-slate-800' : ''
                }`}
              >
                <TierField
                  label="Min"
                  disabled={disabled}
                  placeholder="0"
                  value={t.minAmount}
                  onChange={(v) => setTier(i, { minAmount: v })}
                  error={err[`tier.${i}.minAmount`]}
                />
                <TierField
                  label="Max"
                  disabled={disabled}
                  placeholder={isLast ? '∞' : '10'}
                  value={t.maxAmount}
                  onChange={(v) => setTier(i, { maxAmount: v })}
                  error={err[`tier.${i}.maxAmount`]}
                />
                <div>
                  <span className="mb-1 block text-xs text-slate-500 sm:hidden dark:text-slate-400">
                    Type
                  </span>
                  <select
                    className="input"
                    disabled={disabled}
                    value={t.type}
                    onChange={(e) => setTier(i, { type: e.target.value as 'fixed' | 'percentage' })}
                  >
                    <option value="percentage">%</option>
                    <option value="fixed">Fixed</option>
                  </select>
                </div>
                <TierField
                  label="Value"
                  disabled={disabled}
                  placeholder={t.type === 'percentage' ? '1' : '1.00'}
                  value={t.value}
                  onChange={(v) => setTier(i, { value: v })}
                  error={err[`tier.${i}.value`]}
                />
                <div className="col-span-2 flex items-end justify-end sm:col-span-1">
                  {/* Red is a WARNING about the action here, which is the same
                      meaning it carries on a failed payment — consistent, not a
                      collision. The label is in the accessible name, because an
                      icon-only control that only says what it does in a `title`
                      says nothing to a screen reader. */}
                  <button
                    type="button"
                    className="btn-ghost h-9 w-9 !p-0 text-red-600 disabled:opacity-30 dark:text-red-400"
                    disabled={disabled || draft.tiers.length === 1}
                    title="Remove tier"
                    aria-label={`Remove tier ${i + 1}`}
                    onClick={() => removeTier(i)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            className="btn-secondary !py-1.5 text-xs"
            disabled={disabled}
            onClick={addTier}
          >
            <Plus className="h-3.5 w-3.5" /> Add tier
          </button>
        </div>
      )}
    </div>
  );
}

function TierField({
  label,
  value,
  onChange,
  placeholder,
  error,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <span className="mb-1 block text-xs text-slate-500 sm:hidden dark:text-slate-400">
        {label}
      </span>
      <input
        className={classNames('input', error && 'border-red-600 focus:border-red-600')}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// Small hook to keep a draft in sync when the source commission changes.
export function useCommissionDraft(commission?: Commission | null) {
  const [draft, setDraft] = useState<CommissionDraft>(() => draftFromCommission(commission));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setDraft(draftFromCommission(commission));
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commission]);

  return { draft, setDraft, errors, setErrors };
}
