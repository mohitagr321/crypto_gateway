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
  /**
   * Denomination of the AMOUNTS in a fixed or tiered commission — the flat value
   * and every slab bound. Unused for a percentage, which has no denomination.
   *
   * This has to be part of the draft, not just the form, because settlement now
   * REFUSES an amount-denominated commission whose asset is not the one being
   * settled. If the editor did not carry the existing value, every save from
   * this panel would stamp the backend's USDT default over a fee an operator had
   * deliberately written in BTC — and the next payout on that chain would start
   * throwing, with the panel showing a commission that looks untouched.
   */
  asset: string;
  tiers: TierDraft[];
}

const emptyTier = (): TierDraft => ({ minAmount: '', maxAmount: '', type: 'percentage', value: '' });

export function draftFromCommission(commission?: Commission | null): CommissionDraft {
  if (!commission) {
    return {
      type: 'percentage',
      value: '',
      feePayer: 'client',
      asset: '',
      tiers: [emptyTier()],
    };
  }
  return {
    type: commission.type,
    value: commission.value ?? '',
    feePayer: commission.feePayer ?? 'client',
    asset: commission.asset ?? '',
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
        // Only sent for an amount-denominated commission, and only when set. A
        // percentage carries no amounts, so pinning it to an asset would stop it
        // applying to the others it correctly covers; an empty box means "leave
        // it to the backend default", which is USDT — what a bare number always
        // meant.
        ...(draft.type !== 'percentage' && draft.asset.trim()
          ? { asset: draft.asset.trim().toUpperCase() }
          : {}),
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
    input: {
      clientId,
      type: 'tiered',
      tiers,
      feePayer: draft.feePayer,
      ...(draft.asset.trim() ? { asset: draft.asset.trim().toUpperCase() } : {}),
      note,
    },
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
      /*
        A LEDGER, not a hand-rolled table. Same classes, same measures and the
        same CSS-only scroll shadows as every other table in the console, so a
        slab schedule read here and a payout list read one route away are the
        same object.

        The scroller matters more here than usual: this renders inside a dialog,
        where the content box on a 360px phone is about 280px wide, and an
        unwrapped table inside a modal is the classic way a dialog grows a
        horizontal scrollbar with no visible end. `.ledger-scroll` both contains
        it and shows an edge shadow on whichever side still has table to reach.

        The header used to close on a slate-900 / slate-100 ink rule — a
        2px near-white stroke on the dark ground, which index.css names as the
        scar this system was written to remove. `.ledger` draws the header's own
        hairline instead.
      */
      <div className="ledger-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th scope="col">Range (USDT)</th>
              <th scope="col" className="text-right">
                Rate
              </th>
            </tr>
          </thead>
          <tbody>
            {commission.tiers.map((t, i) => (
              <tr key={i}>
                <td className="num">{tierRangeLabel(t)}</td>
                <td className="num text-right text-slate-900 dark:text-slate-100">
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
            <option value="fixed">Fixed (flat amount)</option>
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

      {/* The denomination, shown only where there are amounts to denominate.
          A fixed value and a slab bound are amounts OF something, and until this
          field existed the number was applied to whatever asset the payment
          happened to arrive in — so a "1" meaning one dollar took one whole
          Bitcoin off a BTC settlement. Settlement now refuses that outright, so
          this is also the only place an operator can make a fee usable on a
          chain that does not settle USDT. */}
      {draft.type !== 'percentage' && (
        <div>
          <label className="label">Denominated in</label>
          <input
            className="input"
            disabled={disabled}
            placeholder="USDT"
            value={draft.asset}
            onChange={(e) => set({ asset: e.target.value })}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            The asset these amounts are in — the symbol as the gateway knows it
            (USDT, USDC, BNB, BTC). Blank means USDT. A commission only applies
            to settlements in this asset; use a percentage for a rate that should
            apply to every asset.
          </p>
        </div>
      )}

      {draft.type !== 'tiered' ? (
        <div>
          <label className="label">
            Value {draft.type === 'percentage' ? '(%)' : `(${draft.asset.trim().toUpperCase() || 'USDT'})`}
          </label>
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

          {/*
            THE SLAB SCHEDULE, IN A WELL.

            A run of bare inputs on the dialog's own surface reads as a form that
            has not finished loading; a slab table is one THING — a schedule — and
            grouping it onto an inset surface is what says so. `.well` is the
            sanctioned inset: one step off the surface it sits on, and no rim
            light, because light does not catch on the top edge of a hole.

            The running heads close on `.rule-b`, a hairline, rather than on the
            slate-900 / slate-100 ink rule they used to — a
            2px near-white stroke across a dark dialog is a scar, and index.css
            says so by name. Tracking drops from 0.18em to the console's 0.14em
            for the same reason it did in the ledger: wide tracking on uppercase
            heads is what actually sets a table's minimum width.
          */}
          <div className="well space-y-3 p-3">
            <div className="rule-b hidden gap-2 pb-1.5 sm:grid sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
              <span className="runhead">Min</span>
              <span className="runhead">Max (∞ if empty)</span>
              <span className="runhead">Type</span>
              <span className="runhead">Value</span>
              <span className="w-11" />
            </div>

            {draft.tiers.map((t, i) => {
              const isLast = i === draft.tiers.length - 1;
              return (
                <div
                  key={i}
                  className={`grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] ${
                    i > 0 ? 'border-t border-[var(--line-soft)] pt-3' : ''
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
                  <div className="min-w-0">
                    <span className="runhead mb-1 sm:hidden">Type</span>
                    <select
                      className="input"
                      disabled={disabled}
                      value={t.type}
                      onChange={(e) =>
                        setTier(i, { type: e.target.value as 'fixed' | 'percentage' })
                      }
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
                        says nothing to a screen reader.

                        44px, up from the 36px a 9-by-9 glyph button computed
                        to. This one is worth the extra care: it is a destructive
                        control sitting immediately beside two number fields, so a
                        mis-tap on a phone deletes a tier the operator was in the
                        middle of typing. */}
                    <button
                      type="button"
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-red-600 transition-colors duration-[var(--dur-press)] hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-30 dark:text-red-400"
                      disabled={disabled || draft.tiers.length === 1}
                      title="Remove tier"
                      aria-label={`Remove tier ${i + 1}`}
                      onClick={() => removeTier(i)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* `!py-1.5 text-xs` is gone: `.btn` now enforces the 44px touch floor
              itself, and the override bought nothing except a control an
              operator misses with a thumb. */}
          <button type="button" className="btn-secondary" disabled={disabled} onClick={addTier}>
            <Plus className="h-4 w-4" aria-hidden /> Add tier
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
    // `min-w-0` because this is a grid child holding a field: a grid item
    // defaults to `min-width: auto` and refuses to shrink under its content, so
    // without it two of these in a 2-column row on a 360px phone push the row
    // wider than the dialog rather than sharing the width.
    <div className="min-w-0">
      {/* The field's name, only below `sm` — above it the column head says it
          once for the whole table. A running head rather than a bare grey line:
          it is the same label gesture the head row uses, one size down. */}
      <span className="runhead mb-1 sm:hidden">{label}</span>
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
