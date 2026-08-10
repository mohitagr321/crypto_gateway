import type { CSSProperties, ReactNode } from 'react';
import { classNames } from '@/lib/format';

/**
 * THE BROADSHEET PRIMITIVES THAT LIVE IN TSX RATHER THAN IN CSS.
 *
 * src/index.css already ships the ported foundation — `.rule`, `.runhead`,
 * `.measure`, `.figure-xl`, `.band`, `.link-ink`, `.amount-*`. It deliberately
 * does NOT ship the three the merchant panel keeps in its own stylesheet
 * (`.figure-lg`, `.ghost`, `.spine-row`), and that file is out of bounds for
 * this phase, so they are expressed here instead — same values, same rationale,
 * one import away from every page.
 *
 * Keep these in step with client-panel/src/index.css. The two panels are one
 * product; an operator moving between them must not be able to tell which app
 * they are standing in from the way a figure is set.
 */

/**
 * THE WORKING FIGURE. `.figure-xl` is a marketing gesture — it clamps up to
 * 7.5rem, which on a console would cost a whole row of data to state one
 * number. `lg` is the same idea at a density a tool can afford: still the
 * largest thing in its block, still the point, but four fit across a stat
 * strip. `xl` is the one-per-screen headline, and on these routes that is a
 * hard ceiling rather than an invitation.
 *
 * Tabular LINING figures, because these are quantities read down a column and
 * proportional digits make a big number look hand-set at the wrong widths.
 */
const FIGURE_STYLE: Record<'lg' | 'xl', CSSProperties> = {
  lg: {
    fontSize: 'clamp(1.625rem, 1.3rem + 0.9vw, 2.125rem)',
    lineHeight: 1.05,
    letterSpacing: '-0.03em',
    fontWeight: 640,
    fontOpticalSizing: 'auto',
  },
  xl: {
    fontSize: 'clamp(2.25rem, 1.6rem + 2.4vw, 3.5rem)',
    lineHeight: 0.95,
    letterSpacing: '-0.04em',
    fontWeight: 640,
    fontOpticalSizing: 'auto',
  },
};

export function Figure({
  children,
  size = 'lg',
  className,
}: {
  children: ReactNode;
  size?: 'lg' | 'xl';
  className?: string;
}) {
  return (
    <p
      className={classNames(
        'block tabular-nums lining-nums text-slate-900 dark:text-slate-50',
        className,
      )}
      style={FIGURE_STYLE[size]}
    >
      {children}
    </p>
  );
}

/**
 * STATIC loading placeholder. Deliberately not the sweeping one: it ran an
 * INFINITE animation, and the frequency boundary bans loops on console routes —
 * which is every route in this app. An operator who opens Transactions forty
 * times a day should not be shown forty shimmering light sweeps. Shape and a
 * stepped opacity say "not loaded yet" perfectly well without a single frame of
 * motion.
 *
 * The old utility's class name is deliberately NOT spelled out here. Tailwind
 * scans .tsx as raw text, comments included, so naming it would regenerate the
 * looping utility and its keyframes into the built stylesheet even though no
 * element in the console uses it — which is exactly what was happening before
 * this comment was reworded.
 */
export function Ghost({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={classNames('block rounded bg-slate-200 dark:bg-slate-800', className)}
      style={style}
    />
  );
}

/**
 * A band's running head, set in INK.
 *
 * The quiet slate `.runhead` labels a column inside a strip; this is one level
 * up — the section of the paper you are in — so it takes the ink step. Same
 * primitive, one utility overriding its colour, rather than a second heading
 * style.
 */
export function BandHead({
  children,
  aside,
  className,
}: {
  children: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classNames(
        'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1',
        className,
      )}
    >
      <h2 className="runhead text-slate-900 dark:text-slate-100">{children}</h2>
      {aside}
    </div>
  );
}

/**
 * THE SPINE. A key/value list set as ruled rows — label ranged left, value
 * ranged right against the same rule. This is the editorial replacement for a
 * two-column grid inside a tinted panel, and it is what the detail views are
 * built from.
 */
export function SpineRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-slate-200 py-2.5 dark:border-slate-800">
      <dt className="shrink-0 text-sm text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-slate-900 dark:text-slate-100">
        {children}
      </dd>
    </div>
  );
}

/**
 * A SHARE BAR — one row's magnitude against the largest in the set.
 *
 * Drawn with `transform: scaleX()` from a zero origin rather than a width, so
 * nothing here is a layout animation; it does not transition at all, because it
 * is drawn from data that is already loaded. Slate, not brand: this is a
 * quantity, not something you can click, and never the sole carrier — the
 * figure it annotates is printed beside it.
 */
export function ShareBar({ fraction }: { fraction: number }) {
  const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" aria-hidden>
      <span
        className="block h-full origin-left rounded-full bg-slate-500 dark:bg-slate-400"
        style={{ transform: `scaleX(${safe})` }}
      />
    </span>
  );
}
