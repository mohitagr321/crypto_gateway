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
  /** Anything that belongs under the figure — a sparkline, a mini key. */
  children?: ReactNode;
  /** Span two columns in the metric grid. For the one figure that leads a page. */
  wide?: boolean;
}

/**
 * The icon's ink, NOT a tinted rounded tile.
 *
 * The tile version painted a brand wash behind a decorative glyph by default,
 * which broke the one colour rule that matters: brand means "something you can
 * click", and a stat tile is not clickable. So the two non-semantic tones
 * resolve to slate-400 — the step documented for decorative icons — and only a
 * genuine state tone is allowed to carry hue, where it is still never the sole
 * carrier because the label is sitting right beside it.
 */
const toneInk: Record<NonNullable<StatCardProps['tone']>, string> = {
  brand: 'text-slate-400',
  blue: 'text-slate-400',
  amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  red: 'text-red-600 dark:text-red-400',
};

/**
 * ONE FIGURE, ON ITS OWN RAISED SURFACE.
 *
 * The outgoing version was a ruled column — a hairline, a running head and a
 * figure, printed directly on the page. That was the right primitive for a
 * broadsheet and the wrong one here: on a page built from lit surfaces, a
 * figure with no surface under it reads as unfinished rather than as
 * restrained.
 *
 * It is a `.spot` surface, so the cursor lights it. That is the whole
 * interaction — there is no hover lift and no scale, because a stat tile is not
 * a button and pretending it is teaches the merchant to click things that do
 * nothing.
 *
 * NOTHING ANIMATES ON MOUNT. No count-up, no entrance. The figure is simply
 * there when the merchant arrives, which is what they came for.
 *
 * `break-words` RATHER THAN `truncate`, and this is a correctness fix rather
 * than a style one: the old tile truncated, and a truncated BALANCE is silent
 * data loss — "1,234,567.89" rendering as "1,234,5…" is a number the merchant
 * will read wrong rather than notice is missing. A long figure now wraps, and
 * the tile grows. `min-w-0` on the grid child is what lets it, since a grid
 * item's default `min-width: auto` refuses to shrink below its content.
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
  children,
  wide = false,
}: StatCardProps) {
  return (
    <div
      className={`surface spot flex h-full min-w-0 flex-col p-4 sm:p-[1.125rem] ${
        wide ? 'sm:col-span-2' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="runhead min-w-0">{label}</span>
        {Icon && <Icon size={14} className={`mt-px shrink-0 ${toneInk[tone]}`} aria-hidden />}
      </div>

      {loading ? (
        <span className="ghost mt-3.5 h-7 w-2/3" aria-hidden />
      ) : (
        <p className="figure-lg mt-2.5 break-words">{value}</p>
      )}

      {!loading && (delta !== null || sub) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {delta !== null && <Delta value={delta} invert={invertDelta} />}
          {(deltaLabel || sub) && (
            <span className="min-w-0 text-xs leading-snug text-slate-500 dark:text-slate-400">
              {deltaLabel ?? sub}
            </span>
          )}
        </div>
      )}

      {children && <div className="mt-auto pt-3">{children}</div>}
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
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold ${cls}`}
      style={{ backgroundColor: 'color-mix(in oklab, currentColor 12%, transparent)' }}
    >
      <Icon size={13} aria-hidden />
      <span className="num">{flat ? '0' : `${Math.abs(value).toFixed(1)}`}%</span>
    </span>
  );
}
