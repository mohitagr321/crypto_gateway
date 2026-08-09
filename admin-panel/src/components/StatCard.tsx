import type { LucideIcon } from 'lucide-react';
import { classNames } from '@/lib/format';

export default function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone = 'brand',
  loading,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  hint?: string;
  tone?: 'brand' | 'blue' | 'amber' | 'purple';
  loading?: boolean;
}) {
  const toneClasses = {
    brand: 'bg-brand-100 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300',
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    purple: 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300',
  }[tone];

  return (
    <div className="card flex items-center gap-4 p-5">
      <div className={classNames('flex h-12 w-12 shrink-0 items-center justify-center rounded-lg', toneClasses)}>
        <Icon className="h-6 w-6" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm text-gray-500 dark:text-gray-400">{label}</p>
        {loading ? (
          <div className="mt-1 h-6 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        ) : (
          <p className="truncate text-2xl font-semibold tracking-tight">{value}</p>
        )}
        {hint && <p className="mt-0.5 truncate text-xs text-gray-400">{hint}</p>}
      </div>
    </div>
  );
}
