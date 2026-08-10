import { Loader2 } from 'lucide-react';
import { classNames } from '@/lib/format';

/**
 * The one thing on this panel that is allowed to loop.
 *
 * `.motion-keep` is the documented opt-out from the reduced-motion catch-all in
 * index.css, and the spinner is exactly what it exists for: a FROZEN spinner
 * reads as a hung request, and on this panel a hung request means an operator is
 * staring at a payout they cannot tell has been sent. The motion here is
 * information, not decoration.
 */
export default function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <div
      className="flex items-center gap-2 py-8 text-sm text-slate-500 dark:text-slate-400"
      role="status"
    >
      <Loader2 className={classNames('motion-keep h-4 w-4 animate-spin', className)} aria-hidden />
      {label ?? <span className="sr-only">Loading…</span>}
    </div>
  );
}
