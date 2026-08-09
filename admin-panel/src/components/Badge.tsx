import type { ReactNode } from 'react';
import { classNames } from '@/lib/format';

type Tone = 'green' | 'yellow' | 'red' | 'blue' | 'gray' | 'purple';

const TONES: Record<Tone, string> = {
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  yellow: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-500/15 dark:text-purple-300',
  gray: 'bg-gray-100 text-gray-600 dark:bg-gray-700/40 dark:text-gray-300',
};

// Map every known status string to a tone.
const STATUS_TONE: Record<string, Tone> = {
  // clients
  active: 'green',
  pending: 'yellow',
  suspended: 'red',
  rejected: 'gray',
  // payments / tx
  waiting: 'yellow',
  confirming: 'blue',
  confirmed: 'green',
  swept: 'purple',
  partial: 'yellow',
  failed: 'red',
  expired: 'gray',
  // payouts
  queued: 'yellow',
  processing: 'blue',
  sent: 'green',
  // webhook / generic
  success: 'green',
  true: 'green',
  false: 'red',
};

export function statusTone(status?: string): Tone {
  if (!status) return 'gray';
  return STATUS_TONE[status.toLowerCase()] ?? 'gray';
}

export default function Badge({
  children,
  tone,
  status,
  className,
}: {
  children?: ReactNode;
  tone?: Tone;
  status?: string;
  className?: string;
}) {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      className={classNames(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize',
        TONES[resolved],
        className
      )}
    >
      {children ?? status}
    </span>
  );
}
