import { Loader2 } from 'lucide-react';
import { classNames } from '@/lib/format';

interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/**
 * THE SPINNER INHERITS ITS INK, which is the change here and the reason it is
 * now identical to the merchant panel's.
 *
 * Taking `currentColor` means that inside a `.btn-primary` while it saves it is
 * white, because the button's text is white; inside a `.btn-secondary` it is the
 * button's ink; and standing alone it is whatever the surrounding type is.
 * Nothing has to pass a colour and no call site can get it wrong — which matters
 * on this panel because the most dangerous verbs (trigger payout, rotate keys)
 * all render one inside a primary control.
 *
 * `motion-keep` is the documented opt-out from the reduced-motion catch-all in
 * index.css, and the spinner is exactly what it exists for: a FROZEN spinner
 * reads as a hung request, and on this panel a hung request means an operator is
 * staring at a payout they cannot tell has been sent. The motion here is
 * information, not decoration — it is the only loop in the console besides the
 * `.st-live` halo.
 *
 * THE SHAPE CHANGED: this is an inline `<span>` now, not a block that reserves its own vertical band. A
 * spinner that reserves its own vertical band is a page-level loading state
 * wearing an inline component's name; `LoadingPanel` below is that state, said
 * once, and the four call sites that want it are listed in the handover report.
 */
export default function Spinner({ size = 20, className = '', label }: SpinnerProps) {
  return (
    <span className={classNames('inline-flex items-center gap-2', className)} role="status">
      <Loader2 className="motion-keep animate-spin" size={size} aria-hidden />
      {label && <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>}
    </span>
  );
}

/**
 * Centred full-panel loading state — a whole route waiting on its first
 * response. This is the one place the spinner is the only thing on screen, so it
 * names its own quiet ink rather than inheriting body ink at full contrast: a
 * waiting indicator should not be the loudest mark on the page.
 */
export function LoadingPanel({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[200px] items-center justify-center text-slate-500 dark:text-slate-400">
      <Spinner size={28} label={label} />
    </div>
  );
}
