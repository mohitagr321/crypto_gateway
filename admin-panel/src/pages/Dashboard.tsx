import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Clock, Send, Users } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import DataTable, { type Column } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Section, { MoreLink } from '@/components/Section';
import Sparkline from '@/components/Sparkline';
import StatCard from '@/components/StatCard';
import {
  AXIS_INK_CLASS,
  AXIS_TICK_SIZE,
  ChartEmpty,
  ChartKey,
  ChartTip,
  MONEY_INK_CLASS,
  MONEY_INK_SWATCH,
  X_AXIS_PROPS,
  Y_AXIS_WIDTH,
} from '@/components/Chart';
import { analytics, apiErrorMessage } from '@/lib/api';
import { formatUsdt } from '@/lib/format';

/**
 * THE FRONT PAGE OF THE OPERATOR CONSOLE.
 *
 * It was set as a broadsheet: one enormous figure in a 5/12 margin column, a
 * ledger strip of supporting figures beside it, then two ruled bands carrying
 * the charts. Well made, and not this system. It is now the same page the
 * merchant panel's Dashboard is — a metric grid with a lead tile spanning two
 * columns, then titled Sections — because the two panels are one product and an
 * operator with both windows open should not be able to tell them apart from the
 * furniture.
 *
 * WHAT THE GRID BUYS OVER THE SPREAD. `auto-fit` + `minmax` reflows four tiles
 * to one without a single breakpoint, and — the part that matters on this panel —
 * a tile can never be squeezed narrower than the figure inside it needs. The old
 * headline was `<Figure size="xl" className="truncate">`, and a truncated float
 * is silent data loss: "12,345,678.90" rendering as "12,345,6…" is a number an
 * operator reads wrong rather than notices is missing. StatCard wraps instead.
 *
 * THE LEAD TILE SPANS TWO COLUMNS. A row of four identical boxes states four
 * numbers at identical weight, so none of them is the point; this page has
 * exactly one headline figure — what the gateway has moved — and it should look
 * like it.
 *
 * EVERY CHART VALUE ALSO EXISTS IN A TABLE, and that is a correctness fix rather
 * than a nicety. Both charts used to expose their per-day figures through a
 * `<Tooltip>` and nowhere else. A tooltip needs hover; touch has none. So an
 * operator on a phone could see the SHAPE of a fortnight of revenue and could
 * not read a single day of it. "Day by day" below carries all four figures per
 * date, sortable and paged, which is the same move the merchant panel's
 * Dashboard makes with the key beside its status donut.
 *
 * NOTHING ANIMATES ON MOUNT. That includes recharts, which does not obey CSS:
 * `<Area>` and `<Bar>` both default to `isAnimationActive`, so the area used to
 * draw itself over 1500ms and the bars used to grow out of the axis every single
 * time an operator opened this page. Both are switched off below and must stay
 * off — this is the screen that gets refreshed all day.
 */

/* ------------------------------------------------------------------ *
 * The day ledger's columns. Module scope, because a fresh array on every
 * render would invalidate DataTable's sort memo on every render.
 * ------------------------------------------------------------------ */

interface DayRow {
  date: string;
  count: number;
  volume: number;
  revenue: number;
}

const dayColumns: Column<DayRow>[] = [
  {
    key: 'date',
    header: 'Date',
    sortValue: (d) => d.date,
    render: (d) => (
      <span className="num font-medium text-slate-900 dark:text-slate-100">{d.date}</span>
    ),
  },
  {
    key: 'count',
    header: 'Payments',
    numeric: true,
    sortValue: (d) => d.count,
    render: (d) => d.count,
  },
  {
    key: 'volume',
    header: 'Volume',
    numeric: true,
    sortValue: (d) => d.volume,
    // Emerald, because this is money that arrived. The ticker is printed on the
    // amount rather than in the header alone: these rows are read one at a time
    // by an operator reconciling a single day, not scanned as a column.
    render: (d) => (
      <span className="amount-in">
        {formatUsdt(d.volume)}
        <span className="font-normal text-slate-500 dark:text-slate-400"> USDT</span>
      </span>
    ),
  },
  {
    key: 'revenue',
    header: 'Commission',
    numeric: true,
    sortValue: (d) => d.revenue,
    // Deliberately NOT a second emerald. Commission is a share of the volume
    // already stated on this row, not a second arrival of money, and painting
    // both columns "funds arrived" would say a day earned twice.
    render: (d) => (
      <span className="num font-medium text-slate-900 dark:text-slate-100">
        {formatUsdt(d.revenue)}
        <span className="font-normal text-slate-500 dark:text-slate-400"> USDT</span>
      </span>
    ),
  },
];

/** Below `md` the four-column ledger becomes a stacked, ruled list. */
function dayMobileRow(d: DayRow) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="num text-[13.5px] font-medium text-slate-900 dark:text-slate-50">{d.date}</p>
        <p className="num mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {d.count} payment{d.count === 1 ? '' : 's'}
        </p>
      </div>
      {/* `break-words`, never `truncate`: a cut amount is read wrong rather than
          noticed as missing, and on a chain float that is the whole figure. */}
      <div className="min-w-0 break-words text-right">
        <p className="amount-in text-sm">{formatUsdt(d.volume)} USDT</p>
        <p className="num mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {formatUsdt(d.revenue)} USDT commission
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => analytics(),
  });

  // recharts takes numbers; the API sends money as strings to preserve
  // numeric(38,18) precision. Converting HERE, at the edge, is deliberate — a
  // chart axis does not need full precision and nothing downstream reconciles
  // against these.
  //
  // `label` is the axis tick and `tipHead` is the full date. A 30-point series
  // cannot print "2026-08-18" thirty times under a 320px plot, and the axis only
  // has to say WHICH DAY relative to its neighbours — the full date is one tap
  // away in the tooltip and printed in full in the ledger below.
  const volumeSeries = useMemo(
    () =>
      (data?.timeseries ?? []).map((b) => ({
        label: b.date.slice(5),
        volume: Number(b.volume),
        tipHead: b.date,
        tipValue: `${formatUsdt(b.volume)} USDT · ${b.count} payment${b.count === 1 ? '' : 's'}`,
      })),
    [data],
  );

  const revenueSeries = useMemo(
    () =>
      (data?.timeseries ?? []).map((b) => ({
        label: b.date.slice(5),
        revenue: Number(b.revenue),
        tipHead: b.date,
        tipValue: `${formatUsdt(b.revenue)} USDT commission`,
      })),
    [data],
  );

  /**
   * The same points the two charts are drawn from, as rows. One ledger rather
   * than one under each chart: they share a date key, so splitting them would
   * make an operator read two tables to answer "what did the 14th do".
   */
  const days: DayRow[] = useMemo(
    () =>
      (data?.timeseries ?? []).map((b) => ({
        date: b.date,
        count: b.count,
        volume: Number(b.volume),
        revenue: Number(b.revenue),
      })),
    [data],
  );

  if (isError) {
    return (
      <>
        <PageHeader
          eyebrow="Overview"
          title="Dashboard"
          description="Gateway activity at a glance"
        />
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const hasSeries = volumeSeries.length > 0;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="What the gateway has processed, and what is still waiting on someone."
        meta={
          isLoading
            ? undefined
            : `updated ${new Date(dataUpdatedAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}${isFetching ? ' · refreshing' : ''}`
        }
      />

      {/* ============================================================
          THE METRIC GRID.
          `auto-fit` + `minmax` rather than a fixed column count: the tiles
          reflow from four across to one without a breakpoint, and a tile can
          never be squeezed below the width its figure needs. `minmax(0, 1fr)`
          on the track is what lets StatCard's `break-words` work at all, since
          a grid item defaults to `min-width: auto` and refuses to shrink under
          its own content.
          ============================================================ */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        <StatCard
          wide
          label="Total volume processed"
          value={
            <>
              {formatUsdt(data?.totalVolume)}{' '}
              <span className="text-[0.5em] font-semibold text-slate-500 dark:text-slate-400">
                USDT
              </span>
            </>
          }
          loading={isLoading}
        >
          {/* The sparkline is the tile's own body, not a second chart: it says
              "this is the shape of that number" in 44px, and the full series is
              one section down for anyone who needs to read it. */}
          {volumeSeries.length > 1 && <Sparkline points={volumeSeries.map((p) => p.volume)} />}
        </StatCard>

        <StatCard
          label="Active clients"
          value={data?.activeClients ?? 0}
          icon={Users}
          loading={isLoading}
          sub="Merchants able to take payments right now"
        />
        <StatCard
          label="Pending payouts"
          value={data?.pendingPayouts ?? 0}
          icon={Send}
          // Amber only when something is genuinely waiting. An amber glyph over
          // a zero is a false alarm, and an operator who learns to ignore one
          // alarm ignores the next. `undefined` rather than a neutral tone: the
          // absence of a state IS the default.
          tone={(data?.pendingPayouts ?? 0) > 0 ? 'amber' : undefined}
          loading={isLoading}
          sub={
            data?.pendingPayoutAmount
              ? `${formatUsdt(data.pendingPayoutAmount)} USDT queued`
              : 'Nothing queued'
          }
        />
        <StatCard
          label="Revenue today"
          value={formatUsdt(data?.todayRevenue)}
          icon={Clock}
          tone="emerald"
          loading={isLoading}
          sub="USDT commission earned since midnight"
        />
      </div>

      {/* THE CAVEAT, stated once and next to the figure it qualifies rather than
          three sections away. This is a FLOW across every chain the gateway
          settles on, not a balance anyone can spend. */}
      <p className="measure-wide mt-3 px-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The headline is USDT, across every merchant and every settlement chain. It is what moved,
        not what is held —{' '}
        <Link to="/wallets" className="link-ink">
          Wallet balances
        </Link>{' '}
        is where the money actually is.
      </p>

      {/* ============================================================
          THE SERIES. Two surfaces rather than two ruled bands: a console
          screen is a stack of unrelated readouts that happen to share a
          route, and grouping each onto its own lit surface is what lets the
          eye land on one of them.
          ============================================================ */}
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <Section
          title="Volume over time"
          aside={<MoreLink to="/transactions">Transactions</MoreLink>}
        >
          {isLoading ? (
            <span className="ghost h-[240px] w-full opacity-60" aria-hidden />
          ) : !hasSeries ? (
            <ChartEmpty>
              Nothing has settled in this period yet. The first confirmed payment starts this
              series.
            </ChartEmpty>
          ) : (
            /* `color` is set on the WRAPPER so the stroke and both gradient stops
               can ask for `currentColor` — a documented recharts prop rather than
               a reach into its DOM — and follow the theme with no JS. */
            <>
              <div className={`${MONEY_INK_CLASS} ${AXIS_INK_CLASS}`}>
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={volumeSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="adminVolFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="currentColor" stopOpacity={0.28} />
                        <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    {/* The shared axis props carry `interval="preserveStartEnd"`
                        and `minTickGap`, which is what makes this readable under
                        400px: without them recharts prints every date whatever
                        the width and thirty labels overlap into a grey smear. */}
                    <XAxis dataKey="label" {...X_AXIS_PROPS} />
                    <YAxis
                      tick={{ fontSize: AXIS_TICK_SIZE }}
                      tickLine={false}
                      axisLine={false}
                      // 40 rather than 56: on a 320px plot the gutter was taking a
                      // sixth of the chart to print four labels.
                      width={Y_AXIS_WIDTH}
                    />
                    <Tooltip
                      content={<ChartTip />}
                      cursor={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="volume"
                      stroke="currentColor"
                      strokeWidth={2}
                      fill="url(#adminVolFill)"
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              {/* The key names the series in WORDS, so the ink is never the only
                  thing carrying it — and the note says where the numbers are,
                  because the tooltip above it does not exist on a touch device.
                  It lives INSIDE this branch on purpose: a key under an empty
                  chart would point at a ledger that is not being rendered. */}
              <ChartKey
                items={[
                  {
                    label: 'Volume settled',
                    swatch: MONEY_INK_SWATCH,
                    note: 'USDT per day, every merchant and every chain — read the figures below',
                  },
                ]}
              />
            </>
          )}
        </Section>

        <Section title="Revenue over time" aside={<MoreLink to="/revenue">Revenue</MoreLink>}>
          {isLoading ? (
            <span className="ghost h-[240px] w-full opacity-60" aria-hidden />
          ) : !hasSeries ? (
            <ChartEmpty>No commission has been earned in this period yet.</ChartEmpty>
          ) : (
            <>
              <div className={`${MONEY_INK_CLASS} ${AXIS_INK_CLASS}`}>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={revenueSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <XAxis dataKey="label" {...X_AXIS_PROPS} />
                    <YAxis
                      tick={{ fontSize: AXIS_TICK_SIZE }}
                      tickLine={false}
                      axisLine={false}
                      width={Y_AXIS_WIDTH}
                    />
                    <Tooltip
                      content={<ChartTip />}
                      cursor={{ fill: 'currentColor', fillOpacity: 0.08 }}
                    />
                    <Bar
                      dataKey="revenue"
                      fill="currentColor"
                      radius={[3, 3, 0, 0]}
                      isAnimationActive={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <ChartKey
                items={[
                  {
                    label: 'Commission earned',
                    swatch: MONEY_INK_SWATCH,
                    note: 'USDT per day — read the figures below',
                  },
                ]}
              />
            </>
          )}
        </Section>
      </div>

      {/* ============================================================
          THE DAY LEDGER — every value both charts draw, in a form a finger
          can reach. This is the fix for the one genuinely functional defect
          on this page: a hover tooltip was the ONLY way to a per-day figure,
          and an operator away from their desk had the shape of the week and
          none of its numbers.
          ============================================================ */}
      {(isLoading || hasSeries) && (
        <Section
          className="mt-4"
          flush
          title="Day by day"
          aside={<MoreLink to="/analytics">Analytics</MoreLink>}
        >
          <DataTable
            columns={dayColumns}
            rows={days}
            rowKey={(d) => d.date}
            loading={isLoading}
            // Newest first: an operator opening this page is asking about today
            // and yesterday, not about the start of the window.
            defaultSortKey="date"
            defaultSortDir="desc"
            renderMobile={dayMobileRow}
            skeletonRows={7}
            pageSize={7}
            label="Volume and commission per day"
            emptyMessage="Nothing has settled in this period yet."
          />
          <p className="measure-wide pb-1 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            The same figures the two charts above are drawn from. Commission is a share of the
            volume on its own row, never an addition to it.
          </p>
        </Section>
      )}
    </>
  );
}
