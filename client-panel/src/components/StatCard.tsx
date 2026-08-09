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

const toneClasses: Record<NonNullable<StatCardProps['tone']>, string> = {
  brand: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
  blue: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
};

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
    <div className="card group h-full p-5 transition duration-300 hover:shadow-lift">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
            {label}
          </p>

          {loading ? (
            <div className="skeleton mt-2 h-8 w-28" />
          ) : (
            <p className="num mt-1.5 truncate text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
              {value}
            </p>
          )}

          {!loading && (delta !== null || sub) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              {delta !== null && <Delta value={delta} invert={invertDelta} />}
              {(deltaLabel || sub) && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {deltaLabel ?? sub}
                </span>
              )}
            </div>
          )}
        </div>

        {Icon && (
          <div className={`shrink-0 rounded-xl p-2.5 transition-transform duration-300 group-hover:scale-105 ${toneClasses[tone]}`}>
            <Icon size={20} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Direction is carried by an ARROW as well as by colour, so the meaning
 * survives for a colour-blind reader and in a greyscale print of a report.
 */
function Delta({ value, invert }: { value: number; invert: boolean }) {
  const flat = Math.abs(value) < 0.05;
  const good = invert ? value < 0 : value > 0;

  const cls = flat
    ? 'text-slate-500 dark:text-slate-400'
    : good
      ? 'text-emerald-700 dark:text-emerald-400'
      : 'text-red-700 dark:text-red-400';

  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${cls}`}>
      <Icon size={13} />
      <span className="num">
        {flat ? '0' : `${Math.abs(value).toFixed(1)}`}%
      </span>
    </span>
  );
}
