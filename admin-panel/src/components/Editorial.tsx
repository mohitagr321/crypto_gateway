import type { CSSProperties, ReactNode } from 'react';
import { classNames } from '@/lib/format';

/**
 * WHAT THIS FILE IS NOW: A MIGRATION SHIM, PLUS ONE REAL COMPONENT.
 *
 * It was written when src/index.css deliberately did NOT ship `.figure-lg`,
 * `.ghost` or `.spine-row`, and that file was out of bounds — so the three were
 * expressed here in TSX instead, with the same values and the same rationale.
 * The stylesheet has since been rebuilt against the "Instrument" system and it
 * now ships all three, so every one of them below has become a wrapper around a
 * class that already exists. They are kept ONLY so the pages that import them
 * keep compiling while those pages are converted; each one names its
 * replacement, and this file should end up holding `ShareBar` and nothing else.
 *
 * `BandHead` used to live here and has been DELETED: it opened a ruled band,
 * which is the structural device "Instrument" replaces outright. `<Section>` is
 * the replacement, and every call site has been migrated.
 *
 * Keeping these in step with client-panel is no longer the job — the stylesheet
 * does that now, which is the point.
 */

/**
 * THE WORKING FIGURE.
 *
 * DEPRECATED for `size="lg"`: write `<p className="figure-lg">` instead, which
 * is what index.css ships and what the merchant panel's StatCard and Dashboard
 * both use. This wrapper delegates to that class rather than restating the
 * clamp, so there is exactly one definition of how a figure is set in this
 * console and it cannot drift from the merchant panel's.
 *
 * `size="xl"` IS THE ONE THING HERE WITH NO CLASS BEHIND IT, and that is on
 * purpose rather than an omission. index.css states the reason: the merchant
 * panel's `.figure-xl` clamps to 7.5rem, which is a marketing gesture, and on a
 * console a single number at 120px costs a whole band of ledger. This `xl` is a
 * smaller thing — a 3.5rem ceiling for the one-per-screen headline figure — and
 * it survives only for the two pages still using it. When they are converted to
 * a lead `<StatCard wide>` the size, and then this component, should go.
 *
 * DO NOT PUT A `text-*` UTILITY ON EITHER. Both are clamps; a utility wins the
 * cascade and pins the figure to one size at every width, which is a real bug
 * that already happened once in this codebase and is why a balance truncated on
 * a phone. `truncate` is the other one to avoid here — a cut money figure is
 * silent data loss, and `break-words` is the correct treatment.
 */
const HEADLINE_STYLE: CSSProperties = {
  fontSize: 'clamp(2.25rem, 1.6rem + 2.4vw, 3.5rem)',
  lineHeight: 0.95,
  letterSpacing: '-0.04em',
  fontWeight: 640,
  fontOpticalSizing: 'auto',
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
  if (size === 'xl') {
    return (
      <p
        className={classNames(
          'block tabular-nums lining-nums text-slate-900 dark:text-slate-50',
          className,
        )}
        style={HEADLINE_STYLE}
      >
        {children}
      </p>
    );
  }
  return <p className={classNames('figure-lg', className)}>{children}</p>;
}

/**
 * STATIC loading placeholder.
 *
 * DEPRECATED: write `<span className="ghost" aria-hidden />` instead. index.css
 * ships `.ghost`, and it derives its fill from `--ink` with `color-mix` rather
 * than naming a slate step, so the placeholder sits a fixed distance from
 * whatever surface it is on in both themes — which the slate-200 / slate-800 pair this used to hard-code did not.
 *
 * Deliberately not the sweeping one: the sweep ran an INFINITE animation, and
 * the frequency boundary bans loops on console routes — which is every route in
 * this app. An operator who opens Transactions forty times a day should not be
 * shown forty shimmering light sweeps. Shape and a stepped opacity say "not
 * loaded yet" perfectly well without a single frame of motion.
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
  return <span aria-hidden className={classNames('ghost', className)} style={style} />;
}

/**
 * THE SPINE. A key/value list set as ruled rows — label ranged left, value
 * ranged right against the same rule. This is what the detail views are built
 * from: a merchant record, a payout, a wallet, a webhook attempt.
 *
 * DEPRECATED: use the `.spine-row` / `.spine-label` / `.spine-value` classes
 * index.css ships, which are the same three measures shared with the merchant
 * panel. This is now a wrapper over exactly those.
 *
 * A rule is still the right primitive HERE, and that is worth saying because the
 * redesign replaced rules with surfaces almost everywhere else: these rows are a
 * list INSIDE a surface rather than a structure of their own, which is the one
 * job a hairline still does better than a box.
 */
export function SpineRow({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="spine-row">
      <dt className="spine-label">{label}</dt>
      <dd className="spine-value">{children}</dd>
    </div>
  );
}

/**
 * A SHARE BAR — one row's magnitude against the largest in the set. The one
 * component in this file that is genuinely a component: there is no class for
 * it in either panel's stylesheet, because it takes a value.
 *
 * Drawn with `transform: scaleX()` from a zero origin rather than a width, so
 * nothing here is a layout animation; it does not transition at all, because it
 * is drawn from data that is already loaded. Slate, not brand: this is a
 * quantity, not something you can click, and never the sole carrier — the figure
 * it annotates is printed beside it.
 *
 * The track is `--surface-2` and the fill is ink, rather than the slate-200 /
 * slate-800 pair this used to name: one custom property follows the theme, and
 * it is the same step every inset surface in the product sits on, so the bar
 * cannot end up a different grey from the well beside it.
 */
export function ShareBar({ fraction }: { fraction: number }) {
  const safe = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return (
    <span
      className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--surface-2)]"
      aria-hidden
    >
      <span
        className="block h-full origin-left rounded-full bg-slate-500 dark:bg-slate-400"
        style={{ transform: `scaleX(${safe})` }}
      />
    </span>
  );
}
