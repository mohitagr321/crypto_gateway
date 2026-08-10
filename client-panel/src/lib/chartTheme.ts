import type { PaymentStatus } from '@/types';

/**
 * CHART INK — the one place in the product that names a colour for recharts.
 *
 * recharts paints SVG, so it takes colour VALUES where every other surface here
 * takes a utility class. That is how four `#94a3b8` literals ended up inside
 * Dashboard.tsx: stock COOL slate, sat on a warm ground, identical in both
 * themes, and invisible to the ramp remap in tailwind.config.js. The pie's seven
 * hues had the same problem — a hardcoded `#4f46e5` slice meant "swept" was
 * painted in the BRAND hue, the one colour reserved for things you can click.
 *
 * Nothing below is a hex. Every value is a Tailwind class resolved against the
 * ramp, so a chart re-grounds with the rest of the product and flips with the
 * theme for free.
 */

/** Axis tick size. Not a colour, but it belongs with the rest of the axis. */
export const AXIS_TICK_SIZE = 11;

/**
 * AXIS INK, applied to the chart's WRAPPER rather than to the axis.
 *
 * The obvious spelling — `tick={{ className: 'fill-slate-400' }}` — does not
 * work, and fails SILENTLY, which is worse. recharts 2.15's
 * `CartesianAxis.renderTickItem` computes a merged className for the element and
 * function forms of `tick`, then for the OBJECT form does
 * `createElement(Text, { ...props, className: 'recharts-cartesian-axis-tick-value' })`,
 * clobbering whatever className the object carried. Verified in
 * node_modules/recharts/lib/cartesian/CartesianAxis.js, not assumed.
 *
 * So the ink is set on the class recharts always writes itself. A CSS rule beats
 * an SVG presentation attribute in the cascade, so this wins over the `fill`
 * recharts derives from the axis `stroke` without needing `!important`. slate-400
 * is the step documented for decorative marks, and it carries on both grounds —
 * which is why there is no `dark:` half.
 */
export const AXIS_INK_CLASS = '[&_.recharts-cartesian-axis-tick-value]:fill-slate-400';

/**
 * Volume is money RECEIVED, so the area is emerald — never brand. Set as
 * `color` on the wrapper so the stroke and the gradient stops can both ask for
 * `currentColor`, which is a documented recharts prop rather than a reach into
 * its DOM, and which follows the theme with no JS.
 */
export const VOLUME_INK_CLASS = 'text-emerald-600 dark:text-emerald-400';

export type StatusGroupId = 'settled' | 'waiting' | 'failed' | 'expired' | 'other';

/**
 * FIELD NAMES ARE LOAD-BEARING HERE — `groupId` and `fillClass`, not `id` and
 * `fill`.
 *
 * recharts spreads each pie DATUM onto the rendered <path> after filtering it
 * against its SVG attribute whitelist, and both `id` and `fill` are on that
 * list. Named the obvious way, this object emitted
 * `fill="fill-emerald-600 dark:fill-emerald-400"` — an invalid paint value — and
 * stamped `id="settled"` onto a path, putting five guessable ids into the
 * document where they can collide with anything else on the page. Confirmed by
 * rendering the chart to static markup and reading the output, then confirmed
 * gone after the rename. Do not rename these back.
 */
export interface StatusGroup {
  groupId: StatusGroupId;
  /** The word. Colour is never the only carrier, on a chart least of all. */
  label: string;
  /** `fill-*` utility. Used for the recharts <Cell> AND for the key's swatch. */
  fillClass: string;
}

/**
 * FOUR MEANINGS, NOT SEVEN HUES — the same collapse Badge.tsx makes.
 *
 * The old pie drew a distinct colour per status: emerald, indigo, amber, sky,
 * purple, red, slate. Six of those carried no meaning in this palette, one of
 * them WAS the brand hue, and none of them agreed with the badge sitting in the
 * table directly below the chart. Grouping first means every slice is a
 * corrected 600/400 state step, and no two slices can share a colour — which is
 * what a pie needs to be readable at all.
 *
 * Nothing is hidden by the grouping: the key prints every underlying status with
 * its own count underneath its group.
 */
export const STATUS_GROUPS: readonly StatusGroup[] = [
  {
    groupId: 'settled',
    label: 'Settled',
    fillClass: 'fill-emerald-600 dark:fill-emerald-400',
  },
  {
    groupId: 'waiting',
    label: 'Waiting',
    fillClass: 'fill-amber-600 dark:fill-amber-400',
  },
  {
    groupId: 'failed',
    label: 'Failed',
    fillClass: 'fill-red-600 dark:fill-red-400',
  },
  {
    groupId: 'expired',
    label: 'Expired',
    fillClass: 'fill-slate-400',
  },
  {
    groupId: 'other',
    label: 'Other',
    fillClass: 'fill-slate-300 dark:fill-slate-600',
  },
];

/**
 * MIRRORS `paymentTone` in components/Badge.tsx and must keep mirroring it: a
 * merchant must never see one green in the table and a different green in the
 * chart for the same status. `swept` is settled because the money did arrive —
 * sweeping is the bookkeeping move that follows. `partial` and `confirming` are
 * both waiting: in one the customer still owes the balance, in the other the
 * chain still owes confirmations.
 *
 * Typed as a total Record, so adding a PaymentStatus without classifying it is a
 * compile error rather than a grey slice nobody notices.
 */
export const STATUS_GROUP_OF: Record<PaymentStatus, StatusGroupId> = {
  waiting: 'waiting',
  confirming: 'waiting',
  partial: 'waiting',
  confirmed: 'settled',
  swept: 'settled',
  failed: 'failed',
  expired: 'expired',
};

/** Runtime-safe lookup: a status the client has never heard of lands in `other`. */
export function statusGroupOf(status: string): StatusGroupId {
  return (STATUS_GROUP_OF as Record<string, StatusGroupId | undefined>)[status] ?? 'other';
}

/**
 * CATEGORICAL SERIES INK — for dimensions that carry NO status meaning.
 *
 * The status charts above stay semantic and must: emerald IS "funds arrived",
 * amber IS "waiting", red IS "failed". Recolouring those to something prettier
 * would break the one contract the whole palette exists to enforce, so this
 * palette is deliberately NOT for them.
 *
 * It is for the dimensions where a hue means nothing at all and is only there
 * to tell one line apart from another — per asset, per network, per client,
 * per payment method. Those were previously drawn in ramp greys or reused a
 * semantic hue, which is how a chart ends up implying that USDC is "settled"
 * and BNB is "failed".
 *
 * ORDERED FOR DISTINGUISHABILITY, not by hue wheel: adjacent entries are far
 * apart in both hue and lightness, so a two-series chart is separable at a
 * glance and an eight-series chart is still separable at the legend. The first
 * four are also distinguishable in the common forms of colour-vision
 * deficiency, which is why blue and orange lead rather than red and green.
 *
 * NONE of these is emerald, amber or red at the steps those use for status —
 * checked deliberately, so a categorical series can never be mistaken for a
 * state readout sitting next to it.
 */
export interface SeriesInk {
  /** Tailwind fill-* class pair, for recharts <Cell> and bars. */
  fillClass: string;
  /** Tailwind stroke-* class pair, for lines and areas. */
  strokeClass: string;
  /** Human label for the key. Colour is never the sole carrier. */
  label: string;
}

export const SERIES_PALETTE: readonly SeriesInk[] = [
  { fillClass: 'fill-brand-600 dark:fill-brand-400', strokeClass: 'stroke-brand-600 dark:stroke-brand-400', label: 'Series 1' },
  { fillClass: 'fill-cyan-600 dark:fill-cyan-400', strokeClass: 'stroke-cyan-600 dark:stroke-cyan-400', label: 'Series 2' },
  { fillClass: 'fill-accent-600 dark:fill-accent-400', strokeClass: 'stroke-accent-600 dark:stroke-accent-400', label: 'Series 3' },
  { fillClass: 'fill-teal-600 dark:fill-teal-400', strokeClass: 'stroke-teal-600 dark:stroke-teal-400', label: 'Series 4' },
  { fillClass: 'fill-fuchsia-600 dark:fill-fuchsia-400', strokeClass: 'stroke-fuchsia-600 dark:stroke-fuchsia-400', label: 'Series 5' },
  { fillClass: 'fill-sky-700 dark:fill-sky-300', strokeClass: 'stroke-sky-700 dark:stroke-sky-300', label: 'Series 6' },
];

/**
 * Pick the ink for series `i`, wrapping past the end of the palette.
 *
 * Wrapping rather than throwing on purpose: the number of assets a deployment
 * settles is operator configuration, not a constant, and a chart must not blow
 * up because someone enabled a seventh coin. Past six the labels are doing the
 * work anyway.
 */
export function seriesInk(i: number): SeriesInk {
  return SERIES_PALETTE[i % SERIES_PALETTE.length];
}
