import type { ReactNode } from 'react';

/**
 * CHART INK — the one place in this console that names a colour for recharts.
 *
 * recharts paints SVG, so it takes colour VALUES where every other surface here
 * takes a utility class. That is how `#1f9968`, `#7c3aed`, `#2563eb`, `#e5e7eb`
 * and `#9ca3af` ended up hardcoded across two pages: a green that is in no ramp,
 * the ACCENT hue on a data series, stock COOL greys sat on a warm ground, and
 * two theme forks computed in JS from `useTheme` — which meant every chart
 * re-rendered on a theme flip instead of just recolouring.
 *
 * Nothing below is a hex. Every value is either a Tailwind class resolved
 * against the ramp, a custom property from the ramp itself, or `currentColor`
 * inherited from a wrapper that carries one — so a chart re-grounds with the
 * rest of the product and flips with the theme for free.
 */

/** Axis tick size. Not a colour, but it belongs with the rest of the axis. */
export const AXIS_TICK_SIZE = 11;

/**
 * AXIS INK, applied to the chart's WRAPPER rather than to the axis.
 *
 * The obvious spelling — `tick={{ className: 'fill-slate-400' }}` — does not
 * work, and fails SILENTLY, which is worse: recharts' CartesianAxis clobbers the
 * className an object-form `tick` carries. So the ink is set on the class
 * recharts always writes itself. A CSS rule beats an SVG presentation attribute
 * in the cascade, so this wins over the fill recharts derives from the axis
 * stroke without needing `!important`. slate-400 is the step documented for
 * decorative marks and it carries on both grounds, which is why there is no
 * `dark:` half.
 */
export const AXIS_INK_CLASS = '[&_.recharts-cartesian-axis-tick-value]:fill-slate-400';

/**
 * MONEY ARRIVED is emerald — never brand. Set as `color` on the wrapper so
 * strokes, fills and gradient stops can all ask for `currentColor`, which is a
 * documented recharts prop rather than a reach into its DOM.
 */
export const MONEY_INK_CLASS = 'text-emerald-600 dark:text-emerald-400';

/**
 * The SECOND series, as a custom property so it flips with the theme the same
 * way everything else does. Slate: commission is a share of a figure that is
 * already on the chart, not a fifth kind of money, and the dashed stroke it is
 * drawn with means the two series are separable without reading colour at all.
 *
 * IT NAMES THE RAMP'S CUSTOM PROPERTY DIRECTLY RATHER THAN GOING THROUGH
 * `theme()`. To be precise about why, because the obvious reason is wrong: the
 * `theme()` spelling this replaced DOES still work. Verified against the built
 * stylesheet rather than assumed — inside an arbitrary property Tailwind
 * resolves `theme('colors.slate.500')` and substitutes `1` for the
 * `<alpha-value>` slot, emitting `--series-2: oklch(var(--n-500) / 1)`.
 *
 * It is changed anyway because `theme()` for a colour is now context-dependent
 * in a way that is easy to get wrong: the same call inside src/index.css, where
 * it is plain CSS rather than a utility, yields a literal `<alpha-value>` and a
 * declaration the browser drops — which is why tailwind.config.js tells you not
 * to reintroduce it and why index.css names the properties directly throughout.
 * One spelling, one behaviour, and this line reads the same as the stylesheet
 * beside it. The output is identical bar an explicit `/ 1`.
 */
export const SECOND_INK_VARS =
  '[--series-2:oklch(var(--n-500))] dark:[--series-2:oklch(var(--n-400))]';
export const SECOND_INK_SWATCH = 'bg-slate-500 dark:bg-slate-400';
export const MONEY_INK_SWATCH = 'bg-emerald-600 dark:bg-emerald-400';

/**
 * THE AXIS PROPS EVERY CHART IN THIS CONSOLE SHOULD SPREAD, and the reason they
 * are exported rather than left to each page: under 400px a recharts axis stops
 * being an axis unless it is told not to.
 *
 * `minTickGap` is what does the work. Without it recharts draws every label
 * whatever the width, so on a phone fourteen dates overlap into a grey smear.
 * With it, labels are dropped until each has 28px of clearance — fewer ticks,
 * all legible. `preserveStartEnd` guarantees the first and last survive that
 * culling, which are the two the reader needs in order to know what window they
 * are looking at.
 *
 * `Y_AXIS_WIDTH` is 40 rather than the 56 the console's charts used: on a 320px
 * plot, 56px of gutter was taking a sixth of the chart to print four labels.
 */
export const X_AXIS_PROPS = {
  tick: { fontSize: AXIS_TICK_SIZE },
  tickLine: false,
  axisLine: false,
  interval: 'preserveStartEnd' as const,
  minTickGap: 28,
};

export const Y_AXIS_WIDTH = 40;

interface Tip {
  tipHead: string;
  tipValue: ReactNode;
}

/**
 * One tooltip for every chart in the console.
 *
 * recharts' default tooltip is a hardcoded white box — which is why the old
 * `contentStyle` had to recompute a background, a border and a text colour from
 * `useTheme` on every render, and why getting one of them wrong rendered
 * white-on-white. This is a normal element with normal classes, so it grounds
 * and flips like everything else. Each datum carries its own pre-formatted
 * `tipHead`/`tipValue`, so formatting lives with the data and no chart needs a
 * bespoke formatter.
 *
 * `.surface` + `shadow-float` rather than a hand-written border and fill: a
 * tooltip genuinely IS a sheet raised above the page — the floating plane — so
 * it is the one readout in this file that gets the heavy cast. It is NOT
 * `.glass`, because glass costs a backdrop repaint per frame and this element
 * moves with the pointer.
 *
 * A TOOLTIP IS NEVER THE ONLY WAY TO A VALUE. Touch has no hover, so anything
 * reachable only through this is unreachable on a phone — pair every chart with
 * a `<ChartKey>` or a ledger underneath it.
 */
export function ChartTip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: Partial<Tip> }[];
}) {
  const d = active ? payload?.[0]?.payload : undefined;
  if (!d?.tipHead) return null;
  return (
    <div className="surface px-3 py-2 shadow-float">
      <span className="runhead">{d.tipHead}</span>
      <p className="num mt-1 text-sm font-medium text-slate-900 dark:text-slate-50">
        {d.tipValue}
      </p>
    </div>
  );
}

/**
 * A series with nothing in it yet. Ranged left on a measure, not centred behind
 * a grey icon: say WHICH nothing this is and what would end it.
 */
export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="measure py-16 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
      {children}
    </p>
  );
}

/**
 * The key that replaces recharts' `<Legend>`, so a series name is never a colour
 * alone — and so its values exist somewhere a finger can reach them.
 */
export function ChartKey({
  items,
}: {
  items: { label: string; swatch: string; note?: string }[];
}) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-baseline gap-2 text-xs">
          <span
            className={`h-1.5 w-4 shrink-0 translate-y-[-2px] rounded-full ${item.swatch}`}
            aria-hidden
          />
          <span className="font-medium text-slate-700 dark:text-slate-300">{item.label}</span>
          {item.note && <span className="text-slate-500 dark:text-slate-400">{item.note}</span>}
        </li>
      ))}
    </ul>
  );
}
