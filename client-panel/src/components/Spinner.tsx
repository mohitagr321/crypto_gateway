import { Loader2 } from 'lucide-react';

interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/**
 * THE SPINNER INHERITS ITS INK, and that is the whole change here.
 *
 * It used to hard-code `text-brand-600`, which broke in two directions at once.
 * Brand means "the action you can take" and never a state, so a brand-coloured
 * spinner spent the one interactive colour on a readout; and the most common
 * call site in this codebase is INSIDE a `.btn-primary` while it saves, where a
 * brand-600 glyph sat on a brand-500/600 gradient and was very nearly invisible.
 *
 * Taking `currentColor` fixes both: in a primary button it is white because the
 * button's text is white, in a secondary button it is the button's ink, and
 * standing alone it is whatever the surrounding type is. Nothing has to pass a
 * colour, and no call site can get it wrong.
 */
export default function Spinner({ size = 20, className = '', label }: SpinnerProps) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`} role="status">
      {/* motion-keep: the reduced-motion catch-all in index.css would otherwise
          freeze this, and a frozen spinner reads as a hung request. Spinning is
          information here, not decoration. */}
      <Loader2 className="motion-keep animate-spin" size={size} aria-hidden />
      {label && <span className="text-sm text-slate-500 dark:text-slate-400">{label}</span>}
    </span>
  );
}

/**
 * Centred full-panel loading state. This is the one place the spinner is the
 * only thing on screen, so it names its own quiet ink rather than inheriting
 * body ink at full contrast — a waiting indicator should not be the loudest
 * mark on the page.
 */
export function LoadingPanel({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[200px] items-center justify-center text-slate-500 dark:text-slate-400">
      <Spinner size={28} label={label} />
    </div>
  );
}
