import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

interface StatCardProps {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  sub?: ReactNode;
  tone?: 'brand' | 'blue' | 'amber' | 'emerald' | 'red';
  loading?: boolean;
  /**
   * Period-over-period change, as a percentage. Optional because a figure with
   * no meaningful comparison (a success rate, a count of open items) is better
   * shown without one than with a fabricated baseline.
   */
  delta?: number | null;
  /** What the delta is measured against, e.g. "vs last 30d". */
  deltaLabel?: string;
  /**
   * Set when DOWN is good — refunds, failures, time-to-settle. Without this a
   * falling failure rate would be painted red, which is precisely backwards.
   */
  invertDelta?: boolean;
}

/**
 * The icon's ink, NOT a tinted rounded tile.
 *
 * The tile version painted `bg-brand-100 text-brand-700` behind a decorative
 * glyph by default, which broke the one colour rule that matters here: brand
 * means "something you can click", and a stat card is not clickable. So the two
 * non-semantic tones resolve to slate-400, the step documented for decorative
 * icons, and only a genuine state tone is allowed to carry hue — where it is
 * still never the sole carrier, because the label is sitting right beside it.
 */
const toneInk: Record<NonNullable<StatCardProps['tone']>, string> = {
  brand: 'text-slate-400',
  blue: 'text-slate-400',
  amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  red: 'text-red-600 dark:text-red-400',
};

/**
 * One figure in a stat strip, set as a RULED COLUMN rather than a box.
 *
 * A row of four bordered, shadowed, rounded cards states four numbers at
 * identical weight inside four identical rectangles, so nothing is the point
 * and the enclosure costs ~24px of padding on every side. Here each figure is
 * opened by a hairline, headed by a running head, and set at `.figure-lg`:
 * lay four across a grid and they read as a ledger strip.
 *
 * Nothing animates on mount — no count-up, no entrance. The figure is simply
 * there when the merchant arrives, which is what they came for.
 */
export default function StatCard({
  label,
  value,
  icon: Icon,
  sub,
  tone = 'brand',
  loading = false,
  delta = null,
  deltaLabel,
  invertDelta = false,
}: StatCardProps) {
  return (
    <div className="rule flex h-full flex-col pt-3">
      <div className="flex items-start justify-between gap-2">
        <span className="runhead min-w-0 truncate">{label}</span>
        {Icon && <Icon size={14} className={`mt-px shrink-0 ${toneInk[tone]}`} aria-hidden />}
      </div>

      {loading ? (
        <span className="ghost mt-3 h-7 w-2/3" aria-hidden />
      ) : (
        <p className="figure-lg mt-2 truncate">{value}</p>
      )}

      {!loading && (delta !== null || sub) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          {delta !== null && <Delta value={delta} invert={invertDelta} />}
          {(deltaLabel || sub) && (
            <span className="text-xs leading-snug text-slate-500 dark:text-slate-400">
              {deltaLabel ?? sub}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Direction is carried by an ARROW as well as by colour, so the meaning
 * survives for a colour-blind reader and in a greyscale print of a report.
 *
 * `invert` is what encodes that DOWN IS GOOD for refunds, failures and
 * time-to-settle: the ARROW always follows the sign (a fall points down,
 * truthfully), and only the COLOUR follows the judgement. Painting a falling
 * failure rate red would be precisely backwards, and drawing an up-arrow for a
 * fall would be a lie about the data.
 */
function Delta({ value, invert }: { value: number; invert: boolean }) {
  const flat = Math.abs(value) < 0.05;
  const good = invert ? value < 0 : value > 0;

  const cls = flat
    ? 'text-slate-500 dark:text-slate-400'
    : good
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';

  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${cls}`}>
      <Icon size={13} aria-hidden />
      <span className="num lining-nums">
        {flat ? '0' : `${Math.abs(value).toFixed(1)}`}%
      </span>
    </span>
  );
}
