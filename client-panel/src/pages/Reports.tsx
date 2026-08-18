import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download, FileBarChart } from 'lucide-react';
import { listPayments } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { downloadCsv, formatAmount, formatDate } from '@/lib/format';
import type { Payment } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import { PaymentStatusBadge } from '@/components/Badge';
import StatCard from '@/components/StatCard';
import Section from '@/components/Section';
import {
  AXIS_INK_CLASS,
  AXIS_TICK_SIZE,
  STATUS_GROUPS,
  VOLUME_INK_CLASS,
  statusGroupOf,
} from '@/lib/chartTheme';
import type { StatusGroupId } from '@/lib/chartTheme';

/**
 * THE RECONCILIATION PAGE.
 *
 * Set the way Dashboard is: a masthead, a strip of metric tiles, then everything
 * else on its own titled surface. The outgoing version printed the range picker,
 * the counts, the per-pair volume and the ledger straight onto the canvas
 * divided by `.rule` bands, which gave the eye nothing to land on — four blocks
 * of equal status running down one column. Each of them is a Section now, and
 * the page is the space between them.
 *
 * THE RANGE PICKER IS INSIDE A SURFACE, deliberately. It is the instrument the
 * rest of the page is read through, and a control floating on the bare canvas
 * reads as unfinished.
 *
 * THE NON-FUNGIBILITY DISCIPLINE is the correctness rule here, exactly as it is
 * on the dashboard: settled volume is grouped per (network, asset) and NEVER
 * summed, because 500 USDT + 500 USDC is not 1,000 of anything the merchant can
 * withdraw. Everything the charts below draw is a COUNT — payments are fungible
 * with each other in a way that money across chains is not — so no chart on this
 * page ever adds two assets together.
 *
 * NOTHING ANIMATES ON MOUNT, including recharts, which does not obey CSS:
 * `<Area>` and `<Pie>` both default to `isAnimationActive` and would redraw
 * themselves every time a merchant changes a date. Both are switched off and
 * must stay off.
 */

function toStartOfDay(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00`).getTime();
}
function toEndOfDay(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999`).getTime();
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

/**
 * A local-time day key.
 *
 * `toISOString().slice(0, 10)` would be the obvious spelling and is wrong here:
 * it keys by UTC, while the filter above brackets the range with LOCAL midnight.
 * West of Greenwich that mismatch drops a payment into the bucket for the
 * previous day, so the chart and the ledger under it would disagree about which
 * day a payment landed on — on the page a merchant exports to reconcile against
 * their books.
 */
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;

/** Asset and network as one label, never two independent facts. */
const pairLabel = (p: Payment) => `${p.asset ?? p.currency} · ${p.network}`;

const isSettled = (p: Payment) => p.status === 'confirmed' || p.status === 'swept';

/* ------------------------------------------------------------------ *
 * Charts
 * ------------------------------------------------------------------ */

interface Tip {
  tipHead: string;
  tipValue: string;
}

/**
 * One tooltip for both charts.
 *
 * recharts' default tooltip is a hardcoded white box with a hardcoded shadow,
 * which renders white-on-white in dark mode. This is a normal element with
 * normal classes, so it grounds and flips like everything else on the page. Each
 * datum carries its own pre-formatted `tipHead`/`tipValue`, so the formatting
 * lives with the data and neither chart needs a bespoke formatter.
 */
function ChartTip({
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
 * A fact from a chart, printed as type.
 *
 * THIS IS NOT DECORATION UNDER THE CHART — it is the touch fallback, and it is
 * the reason the series chart is allowed to have a tooltip at all. A phone has
 * no hover, so any value reachable only by pointing at a shape is a value a
 * merchant on a phone cannot read. The extremes and the totals are therefore
 * always on the page in words, and the tooltip is the enrichment rather than
 * the only route to the number.
 */
function KeyFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="runhead">{label}</span>
      <p className="num mt-1 break-words text-sm font-medium text-slate-900 dark:text-slate-100">
        {children}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Ledger columns. Module scope: a fresh array on every render would
 * invalidate DataTable's sort memo on every keystroke in the range picker.
 * ------------------------------------------------------------------ */

const columns: Column<Payment>[] = [
  {
    key: 'orderId',
    header: 'Order',
    sortValue: (p) => p.orderId,
    render: (p) => (
      <span className="font-medium text-slate-900 dark:text-slate-100">
        {p.orderId}
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    numeric: true,
    sortValue: (p) => Number(p.amount),
    render: (p) => formatAmount(p.amount),
  },
  {
    // What actually arrived — the figure the settled volume above is built
    // from, so the two can be reconciled without opening every payment.
    key: 'amountReceived',
    header: 'Received',
    numeric: true,
    hideOnMobile: true,
    sortValue: (p) => Number(p.amountReceived || 0),
    render: (p) =>
      Number(p.amountReceived || 0) > 0 ? (
        <span className="font-medium text-slate-900 dark:text-slate-50">
          {formatAmount(p.amountReceived)}
        </span>
      ) : (
        <span className="text-slate-500 dark:text-slate-400">—</span>
      ),
  },
  {
    key: 'asset',
    header: 'Asset',
    sortValue: (p) => pairLabel(p),
    render: (p) => (
      <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
        {pairLabel(p)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    sortValue: (p) => p.status,
    render: (p) => <PaymentStatusBadge status={p.status} />,
  },
  {
    key: 'createdAt',
    header: 'Created',
    hideOnMobile: true,
    align: 'right',
    className: 'num',
    sortValue: (p) => new Date(p.createdAt).getTime(),
    render: (p) => (
      <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
        {formatDate(p.createdAt)}
      </span>
    ),
  },
];

/** Below `md` the six-column ledger becomes a stacked, ruled list. */
function paymentMobileRow(p: Payment) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate font-medium text-slate-900 dark:text-slate-100">
          {p.orderId}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {pairLabel(p)}
        </p>
        <p className="num mt-1 text-xs text-slate-500 dark:text-slate-400">
          {formatDate(p.createdAt)}
        </p>
      </div>
      <div className="min-w-0 shrink-0 text-right">
        {/* `break-words`, never `truncate`: an amount clipped to "1,234,5…" is a
            number the merchant reads wrong rather than notices is missing. */}
        <p className="num lining-nums break-words text-base font-semibold text-slate-900 dark:text-slate-50">
          {formatAmount(p.amount)}
        </p>
        <div className="mt-1.5 flex justify-end">
          <PaymentStatusBadge status={p.status} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Reports() {
  const [from, setFrom] = useState(daysAgoStr(30));
  const [to, setTo] = useState(todayStr());

  const query = useQuery({
    queryKey: ['payments', 'report'],
    queryFn: () => listPayments({ limit: 1000 }),
  });

  const filtered = useMemo(() => {
    const all = query.data?.data ?? [];
    const start = toStartOfDay(from);
    const end = toEndOfDay(to);
    return all.filter((p) => {
      const t = new Date(p.createdAt).getTime();
      return t >= start && t <= end;
    });
  }, [query.data, from, to]);

  /**
   * SETTLED VOLUME, PER (NETWORK, ASSET) PAIR — never as one number.
   *
   * This used to reduce every settled payment into a single float and print it
   * with " USDT" welded on the end. On an account that takes both USDT and USDC
   * that figure was 500 + 500 = "1,000.00 USDT": a quantity of a thing the
   * merchant does not have, on the page they would export to reconcile against
   * their books. Assets are not fungible, so volume is grouped exactly the way
   * balances are, and the pair is always named together.
   */
  const totals = useMemo(() => {
    const settled = filtered.filter(isSettled);

    const pairs = new Map<
      string,
      { network: string; asset: string; total: number; count: number }
    >();
    for (const p of settled) {
      const asset = p.asset ?? p.currency;
      const key = `${p.network}:${asset}`;
      const entry = pairs.get(key) ?? {
        network: p.network,
        asset,
        total: 0,
        count: 0,
      };
      entry.total += Number(p.amountReceived || p.amount || 0);
      entry.count += 1;
      pairs.set(key, entry);
    }

    return {
      count: filtered.length,
      settledCount: settled.length,
      byPair: [...pairs.values()].sort((a, b) => b.total - a.total),
    };
  }, [filtered]);

  /**
   * SETTLEMENT PER DAY — a count, never a sum of money.
   *
   * A "volume over time" line would have to add USDT to USDC to draw one
   * series, which is precisely the addition the rest of this page refuses to
   * do. A count of settled payments is the honest series: payments ARE fungible
   * with each other, and "how many landed each day" is the shape a merchant
   * actually reads a range for.
   *
   * EVERY DAY IN THE RANGE GETS A BUCKET, including the empty ones. A series
   * built only from days that had activity silently compresses a quiet week into
   * a single step and makes a gap look like a plateau. The walk is done with
   * `setDate`, not by adding 86,400,000ms, so it stays correct across a DST
   * boundary — an hour-short day would otherwise shift every subsequent bucket.
   *
   * Past ~400 buckets the series stops being a shape anyone can read and starts
   * being paint cost, so a wider range simply does not draw one and says so.
   */
  const daily = useMemo(() => {
    const start = toStartOfDay(from);
    const end = toEndOfDay(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;

    const counts = new Map<string, { all: number; settled: number }>();
    for (const p of filtered) {
      const key = dayKey(new Date(p.createdAt));
      const entry = counts.get(key) ?? { all: 0, settled: 0 };
      entry.all += 1;
      if (isSettled(p)) entry.settled += 1;
      counts.set(key, entry);
    }

    const points: {
      date: string;
      label: string;
      settled: number;
      all: number;
      tipHead: string;
      tipValue: string;
    }[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= end) {
      if (points.length > 400) return null;
      const key = dayKey(cursor);
      const entry = counts.get(key) ?? { all: 0, settled: 0 };
      points.push({
        date: key,
        label: key.slice(5),
        settled: entry.settled,
        all: entry.all,
        tipHead: key,
        tipValue: `${entry.settled} settled · ${entry.all} ${
          entry.all === 1 ? 'payment' : 'payments'
        }`,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    return points;
  }, [filtered, from, to]);

  /** The two facts a touch reader cannot get from the series by hovering. */
  const dailyKey = useMemo(() => {
    if (!daily || daily.length === 0) return null;
    const busiest = daily.reduce((best, d) => (d.settled > best.settled ? d : best));
    const active = daily.filter((d) => d.settled > 0).length;
    return { busiest, active, days: daily.length };
  }, [daily]);

  /**
   * Statuses grouped onto the four MEANINGS before they are drawn — see
   * lib/chartTheme.ts. A pie needs one colour per slice to be readable at all,
   * and this palette has four state inks, so the alternative was seven
   * decorative hues that disagreed with the badges in the ledger below.
   *
   * Nothing is lost by the grouping: the key beside the chart prints every
   * underlying status with its own count.
   */
  const statusGroups = useMemo(() => {
    const acc = new Map<StatusGroupId, { count: number; members: Map<string, number> }>();
    for (const p of filtered) {
      const id = statusGroupOf(p.status);
      const entry = acc.get(id) ?? { count: 0, members: new Map<string, number>() };
      entry.count += 1;
      entry.members.set(p.status, (entry.members.get(p.status) ?? 0) + 1);
      acc.set(id, entry);
    }
    const total = filtered.length;

    return STATUS_GROUPS.filter((g) => (acc.get(g.groupId)?.count ?? 0) > 0).map((g) => {
      const entry = acc.get(g.groupId)!;
      const share = total > 0 ? (entry.count / total) * 100 : 0;
      return {
        ...g,
        value: entry.count,
        share,
        members: [...entry.members.entries()].map(([s, n]) => `${s} ${n}`).join(' · '),
        tipHead: g.label,
        tipValue: `${entry.count} ${entry.count === 1 ? 'payment' : 'payments'} · ${share.toFixed(0)}%`,
      };
    });
  }, [filtered]);

  // The query asks for one page of 1000. Say so when there is more behind it,
  // rather than letting a merchant reconcile against a silently short report.
  const fetched = query.data?.data.length ?? 0;
  const reportTotal = query.data?.total;
  const truncated = typeof reportTotal === 'number' && reportTotal > fetched;

  const resetToLast30 = () => {
    setFrom(daysAgoStr(30));
    setTo(todayStr());
  };

  const handleExport = () => {
    const headers = [
      'paymentId',
      'orderId',
      'amount',
      'amountReceived',
      'currency',
      'network',
      'status',
      'confirmations',
      'address',
      'txHash',
      'createdAt',
      'expiresAt',
    ];
    const rows = filtered.map((p) => [
      p.paymentId,
      p.orderId,
      p.amount,
      p.amountReceived,
      p.currency,
      p.network,
      p.status,
      p.confirmations,
      p.address,
      p.txHash ?? '',
      p.createdAt,
      p.expiresAt,
    ]);
    downloadCsv(`payments_${from}_to_${to}.csv`, headers, rows);
  };

  const loading = query.isLoading;

  return (
    <>
      <PageHeader
        eyebrow="Reporting"
        title="Reports"
        description="Filter by date range and export your payment data as CSV."
        actions={
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={filtered.length === 0}
          >
            <Download size={16} aria-hidden /> Download CSV
          </button>
        }
        meta={
          query.data
            ? `${filtered.length} payment${filtered.length === 1 ? '' : 's'} · ${from} to ${to}`
            : undefined
        }
      />

      {/* ============================================================
          THE RANGE. On its own surface, because it is a control: the whole
          page below is a reading of whatever these two dates say, and a
          toolbar printed on the bare canvas reads as unfinished.

          The presets range right of the fields from `sm` up and sit under
          them below it. `w-full` on each field's wrapper below `sm` is what
          keeps the two date inputs from being squeezed to a width iOS renders
          as an unreadable stub.
          ============================================================ */}
      <Section
        title="Date range"
        aside={
          <span className="num text-xs text-slate-500 dark:text-slate-400">
            {from} → {to}
          </span>
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 sm:w-48">
            <label className="label" htmlFor="from">
              From
            </label>
            <input
              id="from"
              type="date"
              className="input num"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="min-w-0 sm:w-48">
            <label className="label" htmlFor="to">
              To
            </label>
            <input
              id="to"
              type="date"
              className="input num"
              value={to}
              min={from}
              max={todayStr()}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex gap-2 sm:ml-auto">
            <button
              className="btn-secondary"
              onClick={() => {
                setFrom(daysAgoStr(7));
                setTo(todayStr());
              }}
            >
              7 days
            </button>
            <button className="btn-secondary" onClick={resetToLast30}>
              30 days
            </button>
          </div>
        </div>
      </Section>

      {/* ============================================================
          THE COUNTS. `auto-fit` + `minmax` rather than `grid-cols-2`: the
          tiles reflow from three across to one without a breakpoint, and a
          tile can never be squeezed below the width its figure needs. The old
          two-up grid put a `.figure-lg` in a ~148px column on a 360px phone,
          which is the shape that made figures truncate.
          ============================================================ */}
      <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        <StatCard
          label="Payments in range"
          value={totals.count}
          icon={FileBarChart}
          loading={loading}
          sub="all statuses"
        />
        <StatCard
          label="Settled"
          value={totals.settledCount}
          tone="emerald"
          loading={loading}
          sub="confirmed or swept"
        />
        <StatCard
          label="Not settled"
          value={totals.count - totals.settledCount}
          tone="amber"
          loading={loading}
          sub="waiting, partial, expired or failed"
        />
      </div>

      {/* ============================================================
          THE CHARTS. Two surfaces on a 3-column grid — the series takes two,
          the composition takes one, because a long series needs the width and
          a four-slice donut does not.
          ============================================================ */}
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <Section className="lg:col-span-2" title="Settled payments · per day">
          {loading ? (
            <span className="ghost h-[220px] w-full opacity-60" aria-hidden />
          ) : !daily ? (
            <p className="measure py-12 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              This range is too wide to draw as a daily series. Narrow it to a
              year or less — the ledger below and the CSV cover the whole range
              either way.
            </p>
          ) : filtered.length === 0 ? (
            <p className="measure py-12 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              No payments in this range, so there is nothing to plot.
            </p>
          ) : (
            <>
              {/* `color` is set HERE so the stroke and the gradient stops can
                  both ask for `currentColor` — a documented recharts prop
                  rather than a reach into its DOM — and follow the theme with
                  no JS. Emerald because these are payments that SETTLED, which
                  is the one thing emerald is allowed to mean. */}
              <div className={`${VOLUME_INK_CLASS} ${AXIS_INK_CLASS}`}>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="report-settled" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="currentColor" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    {/*
                      `minTickGap` is what makes this chart readable under
                      400px. Without it recharts draws a label for every day in
                      the range whatever the width, so on a phone a 30-day
                      series overlaps into a grey smear and the axis stops
                      being an axis. With it, recharts drops labels until each
                      has 28px of clearance. `preserveStartEnd` guarantees the
                      first and last dates survive that culling, which are the
                      two the reader needs to know what window they are in.
                    */}
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: AXIS_TICK_SIZE }}
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      minTickGap={28}
                    />
                    <YAxis
                      tick={{ fontSize: AXIS_TICK_SIZE }}
                      tickLine={false}
                      axisLine={false}
                      // Counts are short integers and the gutter is charged
                      // against the plot: 40 rather than 48 keeps an eighth of
                      // a 320px chart from going to four one-digit labels.
                      width={40}
                      allowDecimals={false}
                    />
                    <Tooltip
                      content={<ChartTip />}
                      cursor={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="settled"
                      stroke="currentColor"
                      strokeWidth={2}
                      fill="url(#report-settled)"
                      // The dashboard's motion budget: no entrance, ever.
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* THE KEY. Touch has no hover, so the numbers a pointer would
                  fish out of the tooltip are printed here as well — the
                  extremes and the coverage, which are what a series is read
                  for once the shape has been taken in. */}
              {dailyKey && (
                <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-6 gap-y-3 border-t border-[var(--line-soft)] pt-3">
                  <KeyFact label="Settled in range">{totals.settledCount}</KeyFact>
                  <KeyFact label="Busiest day">
                    {dailyKey.busiest.settled > 0 ? (
                      <>
                        {dailyKey.busiest.date}
                        <span className="font-normal text-slate-500 dark:text-slate-400">
                          {' '}
                          · {dailyKey.busiest.settled}
                        </span>
                      </>
                    ) : (
                      <span className="font-normal text-slate-500 dark:text-slate-400">
                        none
                      </span>
                    )}
                  </KeyFact>
                  <KeyFact label="Days with a settlement">
                    {dailyKey.active}
                    <span className="font-normal text-slate-500 dark:text-slate-400">
                      {' '}
                      of {dailyKey.days}
                    </span>
                  </KeyFact>
                </div>
              )}
            </>
          )}
        </Section>

        <Section title="Composition · by status">
          {loading ? (
            <span className="ghost h-[190px] w-full opacity-60" aria-hidden />
          ) : statusGroups.length === 0 ? (
            <p className="measure py-12 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              No payments in this range.
            </p>
          ) : (
            <>
              <div className={AXIS_INK_CLASS}>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={statusGroups}
                      dataKey="value"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      // Percentages, not pixels: a radius in px does not shrink
                      // with the container, so a donut tuned on a desktop
                      // overflows its own box on a phone.
                      innerRadius="58%"
                      outerRadius="92%"
                      paddingAngle={2}
                      // recharts' default sector stroke is a hardcoded white,
                      // which draws white hairlines between slices on the dark
                      // ground. paddingAngle already separates them.
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {statusGroups.map((g) => (
                        <Cell key={g.groupId} className={g.fillClass} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTip />} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              {/* The key, replacing recharts' <Legend>: it carries the WORD,
                  the count and the share, so the slice colour never has to be
                  read on its own, and it names every underlying status. This is
                  also the only way these values are reachable on a touch
                  device, where a hover tooltip is not. */}
              <ul className="mt-3">
                {statusGroups.map((g) => (
                  <li
                    key={g.groupId}
                    className="flex items-start justify-between gap-3 border-t border-[var(--line-soft)] py-2 first:border-t-0"
                  >
                    <span className="flex min-w-0 gap-2">
                      <svg
                        width="8"
                        height="8"
                        viewBox="0 0 8 8"
                        className="mt-1.5 shrink-0"
                        aria-hidden
                      >
                        <circle cx="4" cy="4" r="4" className={g.fillClass} />
                      </svg>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                          {g.label}
                        </span>
                        <span className="block break-words text-xs leading-snug text-slate-500 dark:text-slate-400">
                          {g.members}
                        </span>
                      </span>
                    </span>
                    <span className="num shrink-0 pt-0.5 text-right text-sm text-slate-700 dark:text-slate-300">
                      {g.value}
                      <span className="text-slate-500 dark:text-slate-400">
                        {' '}
                        · {g.share.toFixed(0)}%
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>

      {/* ============================================================
          SETTLED VOLUME. One ruled column per (network, asset) pair, inside
          the surface rather than printed on the canvas. A `.rule` still
          divides content WITHIN a surface — what it no longer does is carry
          the page's structure.
          ============================================================ */}
      <Section className="mt-4" title="Settled volume · per network and asset">
        {loading ? (
          <div
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-x-8 gap-y-6"
            aria-busy="true"
          >
            {[0, 1].map((i) => (
              <div key={i} className="rule pt-3">
                <span className="ghost h-3 w-24" aria-hidden />
                <span
                  className="ghost mt-3 h-7 w-2/3"
                  aria-hidden
                  style={{ opacity: 1 - i * 0.35 }}
                />
                <span className="ghost mt-2.5 h-2.5 w-16" aria-hidden />
              </div>
            ))}
            <span className="sr-only" role="status">
              Loading settled volume…
            </span>
          </div>
        ) : totals.byPair.length === 0 ? (
          <p className="measure text-base leading-relaxed text-slate-700 dark:text-slate-300">
            Nothing settled in this range.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-x-8 gap-y-6">
              {totals.byPair.map((pair) => (
                <div key={`${pair.network}:${pair.asset}`} className="rule min-w-0 pt-3">
                  <span className="runhead break-words">
                    {pair.asset} · {pair.network}
                  </span>
                  {/* `break-words`, NOT `truncate`. A truncated balance is
                      silent data loss, and the tile is allowed to grow
                      instead — which is what `min-w-0` on the grid child and
                      `min(100%, …)` on the track exist to permit. */}
                  <p className="figure-lg mt-2 break-words">
                    {formatAmount(pair.total)}
                  </p>
                  <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
                    settled from <span className="num">{pair.count}</span>{' '}
                    payment{pair.count === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
            </div>
            {totals.byPair.length > 1 && (
              <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Shown per network and asset, never summed — assets are not
                fungible, so a combined figure would be a quantity of something
                you do not hold.
              </p>
            )}
          </>
        )}
      </Section>

      {/* ============================================================
          THE LEDGER. `flush`, because a table ranges to the edges of its own
          surface — padding would inset the rows from the rules dividing them.
          ============================================================ */}
      <Section
        className="mt-4"
        flush
        title="Payments in range"
        aside={
          !loading && !query.isError && filtered.length > 0 ? (
            <span className="num text-xs text-slate-500 dark:text-slate-400">
              {filtered.length} row{filtered.length === 1 ? '' : 's'}
            </span>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(p) => p.paymentId}
          loading={loading}
          error={query.isError ? errorMessage(query.error) : null}
          onRetry={() => query.refetch()}
          emptyLabel="No payments in this date range."
          emptyHint="The range filters payments already loaded — widen it to see more."
          emptyAction={
            <button className="btn-secondary" onClick={resetToLast30}>
              Reset to last 30 days
            </button>
          }
          label="Payments in range"
          skeletonRows={8}
          renderMobile={paymentMobileRow}
          stickyFirstColumn
          // `dvh`, never `vh`: on mobile Safari `vh` measures the viewport
          // WITHOUT the collapsing toolbar, so a `62vh` scroller is taller than
          // what the merchant can actually see.
          maxHeight="62dvh"
        />

        {truncated && (
          <p className="measure-wide pb-1 pt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            This report reads the most recent <span className="num">{fetched}</span>{' '}
            of <span className="num">{reportTotal}</span> payments on the account. A
            range reaching further back than that will be incomplete — narrow the
            range, or pull the full history from the API.
          </p>
        )}
      </Section>
    </>
  );
}
