import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Figure, Ghost } from './Editorial';

/**
 * The icon's INK, not a tinted rounded tile.
 *
 * The tile version painted `bg-brand-100 text-brand-700` behind a decorative
 * glyph by default, which broke the one colour rule that matters here: brand
 * means "something you can click", and a stat figure is not clickable. So the
 * two non-semantic tones resolve to slate-400 — the step documented for
 * decorative icons — and only a genuine state tone is allowed to carry hue,
 * where it is still never the sole carrier because the label sits right beside
 * it.
 */
const toneInk = {
  brand: 'text-slate-400',
  blue: 'text-slate-400',
  purple: 'text-slate-400',
  neutral: 'text-slate-400',
  amber: 'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  red: 'text-red-600 dark:text-red-400',
} as const;

/**
 * One figure in a stat strip, set as a RULED COLUMN rather than a box.
 *
 * A row of four bordered, shadowed, rounded cards states four numbers at
 * identical weight inside four identical rectangles, so nothing is the point and
 * the enclosure costs ~24px of padding on every side. Here each figure is opened
 * by a hairline, headed by a running head, and set at the working figure size:
 * lay four across a grid and they read as a ledger strip.
 *
 * NOTHING ANIMATES ON MOUNT — no count-up, no entrance. The figure is simply
 * there when the operator arrives, which is what they came for.
 */
export default function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = 'brand',
  loading,
}: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  /** The footnote that keeps the figure honest — the asset, the period, the caveat. */
  hint?: ReactNode;
  tone?: keyof typeof toneInk;
  loading?: boolean;
}) {
  return (
    <div className="rule flex h-full flex-col pt-3">
      <div className="flex items-start justify-between gap-2">
        <span className="runhead min-w-0 truncate">{label}</span>
        {Icon && <Icon size={14} className={`mt-px shrink-0 ${toneInk[tone]}`} aria-hidden />}
      </div>

      {loading ? (
        <Ghost className="mt-3 h-7 w-2/3" />
      ) : (
        <Figure className="mt-2 truncate">{value}</Figure>
      )}

      {!loading && hint && (
        <p className="mt-2 text-xs leading-snug text-slate-500 dark:text-slate-400">{hint}</p>
      )}
    </div>
  );
}
