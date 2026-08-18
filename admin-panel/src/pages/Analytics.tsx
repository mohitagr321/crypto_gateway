import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Coins, TrendingUp } from 'lucide-react';
import DataTable, { type Column } from '@/components/DataTable';
import { ShareBar } from '@/components/Editorial';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import StatCard from '@/components/StatCard';
import {
  AXIS_INK_CLASS,
  AXIS_TICK_SIZE,
  ChartEmpty,
  ChartKey,
  ChartTip,
  MONEY_INK_CLASS,
  MONEY_INK_SWATCH,
  SECOND_INK_SWATCH,
  SECOND_INK_VARS,
  X_AXIS_PROPS,
  Y_AXIS_WIDTH,
} from '@/components/Chart';
import { LoadingPanel } from '@/components/Spinner';
import { analytics, apiErrorMessage } from '@/lib/api';
import { formatUsdt, networkLabel } from '@/lib/format';
import type { ClientBreakdown } from '@/types';

/**
 * THE BREAKDOWN — where the gateway's money came from.
 *
 * TWO CHARTS BECAME ONE LEDGER, on purpose. "Commission share by client" was a
 * donut cycling eight hardcoded hues, and "Volume by client" was the same rows
 * again as paired bars; between them they answered "who pays us" less precisely
 * than a ranked table does, and cost every colour in the product to do it. The
 * time series stays a chart because a series over time genuinely is one.
 *
 * NOTHING ANIMATES ON MOUNT — recharts does not obey CSS, so `isAnimationActive`
 * is switched off explicitly and must stay off.
 *
 * NO VALUE ON THIS PAGE IS REACHABLE ONLY BY HOVERING. That is the rule the
 * chart below is built to, and it is a mobile rule rather than a stylistic one:
 * touch has no hover, so a figure that lives in a `<Tooltip>` and nowhere else
 * does not exist on a phone. The series therefore ships with a key that carries
 * its most recent values AND a day-by-day ledger under it, which is the same
 * pairing the merchant panel's dashboard makes for its donut.
 */

interface SeriesPoint {
  date: string;
  revenue: number;
  commission: number;
  tipHead: string;
  tipValue: string;
}

/**
 * The day-by-day ledger under the chart. Module scope, because a fresh array on
 * every render would invalidate DataTable's sort memo on every render.
 */
const seriesColumns: Column<SeriesPoint>[] = [
  {
    key: 'date',
    header: 'Day',
    sortValue: (p) => p.date,
    render: (p) => <span className="num text-slate-700 dark:text-slate-300">{p.date}</span>,
  },
  {
    key: 'revenue',
    header: 'Revenue',
    numeric: true,
    sortValue: (p) => p.revenue,
    render: (p) => (
      <span className="amount-in">
        {formatUsdt(p.revenue)} <span className="font-normal">USDT</span>
      </span>
    ),
  },
  {
    key: 'commission',
    header: 'Commission',
    numeric: true,
    sortValue: (p) => p.commission,
    render: (p) => (
      <span className="text-slate-700 dark:text-slate-300">
        {formatUsdt(p.commission)}
        <span className="text-slate-500 dark:text-slate-400"> USDT</span>
      </span>
    ),
  },
];

function seriesMobileRow(p: SeriesPoint) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="num min-w-0 truncate text-slate-700 dark:text-slate-300">{p.date}</span>
      <span className="min-w-0 shrink-0 text-right">
        <span className="amount-in block break-words text-sm">
          {formatUsdt(p.revenue)} USDT
        </span>
        <span className="num block break-words text-xs text-slate-500 dark:text-slate-400">
          {formatUsdt(p.commission)} USDT commission
        </span>
      </span>
    </div>
  );
}

export default function Analytics() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => analytics(),
  });

  const series: SeriesPoint[] = useMemo(
    () =>
      (data?.timeseries ?? []).map((b) => ({
        date: b.date,
        revenue: Number(b.revenue),
        commission: Number(b.commission),
        tipHead: b.date,
        tipValue: `${formatUsdt(b.revenue)} revenue · ${formatUsdt(b.commission)} commission`,
      })),
    [data],
  );

  const breakdown = data?.clientBreakdown ?? [];

  // The largest commission in the set is what every share bar is drawn against.
  // Share OF THE TOTAL would be the more familiar number, but on a long tail it
  // renders forty bars all one pixel wide; against the leader the ranking is
  // readable, and the figure beside each bar is the real one either way.
  const topCommission = useMemo(
    () => breakdown.reduce((max, c) => Math.max(max, Number(c.commission) || 0), 0),
    [breakdown],
  );

  const clientColumns: Column<ClientBreakdown>[] = [
    {
      key: 'client',
      header: 'Client',
      sortValue: (c) => c.clientName.toLowerCase(),
      render: (c) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">{c.clientName}</span>
      ),
    },
    {
      key: 'volume',
      header: 'Volume',
      numeric: true,
      sortValue: (c) => Number(c.volume) || 0,
      render: (c) => (
        <span className="text-slate-700 dark:text-slate-300">
          {formatUsdt(c.volume)}
          <span className="text-slate-500 dark:text-slate-400"> USDT</span>
        </span>
      ),
    },
    {
      key: 'commission',
      header: 'Commission',
      numeric: true,
      sortValue: (c) => Number(c.commission) || 0,
      render: (c) => (
        <span className="amount-in">
          {formatUsdt(c.commission)} <span className="font-normal">USDT</span>
        </span>
      ),
    },
    {
      key: 'share',
      header: 'Against the top earner',
      hideOnMobile: true,
      className: 'w-48',
      render: (c) => (
        <>
          <span className="num block text-xs text-slate-500 dark:text-slate-400">
            {topCommission > 0
              ? `${(((Number(c.commission) || 0) / topCommission) * 100).toFixed(0)}%`
              : '—'}
          </span>
          <ShareBar fraction={topCommission > 0 ? (Number(c.commission) || 0) / topCommission : 0} />
        </>
      ),
    },
  ];

  if (isLoading) return <LoadingPanel label="Loading analytics…" />;
  if (isError || !data) {
    return (
      <>
        <PageHeader
          eyebrow="Overview"
          title="Analytics"
          description="Revenue and commission breakdown"
        />
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const networkRows = data.networkBreakdown ?? [];
  const latest = series.length > 0 ? series[series.length - 1] : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Analytics"
        description="What the gateway earned, which chain it came over, and which merchants it came from."
      />

      {/* ============================================================
          THE SPREAD.

          `auto-fit` + `minmax` rather than a fixed column count: the tiles
          reflow from three across to one without a single breakpoint, and — more
          importantly — a tile can never be squeezed below the width its figure
          needs. `minmax(min(100%, …), 1fr)` on the track is what allows the
          `break-words` inside StatCard to work at all, since a grid item
          defaults to `min-width: auto` and refuses to shrink under its content.

          The lead tile spans two columns. A row of three identical boxes states
          three numbers at identical weight, so none of them is the point; this
          page has exactly one headline figure — what the business actually made
          — and it should look like it.

          IT IS A TILE NOW, NOT A 3.5REM HEADLINE. `Editorial`'s `Figure
          size="xl"` was the only thing keeping that size alive, it carried
          `truncate` on a money figure, and its own note names `<StatCard wide>`
          as the replacement. One figure at 56px costs a whole band of ledger on
          a console, and this page has three ledgers below it.
          ============================================================ */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
        <StatCard
          wide
          label="Total commission earned"
          value={
            <>
              {formatUsdt(data.totalCommission)}{' '}
              <span className="text-[0.5em] font-semibold text-slate-500 dark:text-slate-400">
                USDT
              </span>
            </>
          }
          sub="Every merchant and every chain, for the whole life of the gateway"
        />
        <StatCard
          label="Total revenue"
          value={formatUsdt(data.totalRevenue)}
          icon={Coins}
          tone="emerald"
          sub="USDT recognised as gateway income"
        />
        <StatCard
          label="Total volume"
          value={formatUsdt(data.totalVolume)}
          icon={TrendingUp}
          sub="USDT processed on behalf of merchants"
        />
      </div>

      {/* THE CAVEAT, stated once and next to the figure it qualifies rather than
          three sections away. Commission is held per chain and is only
          withdrawable from the chain it was earned on. */}
      <p className="measure-wide mt-3 px-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The headline is a lifetime total across every chain. It is held per chain
        and is only withdrawable from the chain it was earned on — Revenue is
        where that split lives, and where a withdrawal is actually made.
      </p>

      {/* ============================================================
          PER CHAIN. The totals above are chain-agnostic — one business — but
          volume per chain is what tells you which hot wallet is filling up and
          which one has to stay funded. A chain with no volume is still listed,
          so one that was expected to be earning and isn't is visible rather
          than absent.
          ============================================================ */}
      {networkRows.length > 0 && (
        <Section className="mt-4" title="Volume by chain">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-x-10 gap-y-6">
            {networkRows.map((n) => (
              /* A hairline inside a surface, which is the one job a rule still
                 does: these are readouts within a card, not a structure of their
                 own. */
              <div key={n.network} className="rule min-w-0 pt-3">
                <span className="runhead break-words">{networkLabel(n.network)}</span>
                {/* `break-words`, NOT `truncate`. A cut volume figure is a
                    number an operator reads wrong rather than notices is
                    missing, and the block is allowed to grow instead. */}
                <p className="figure-lg mt-1.5 break-words">{formatUsdt(n.volume)}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  USDT · {n.count} payment{n.count === 1 ? '' : 's'} ·{' '}
                  <span className="num">{formatUsdt(n.commission)}</span> USDT commission
                </p>
                {!n.enabled && (
                  // Not a failure — a chain the gateway is not currently
                  // settling on. Slate, and the word carries it.
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Disabled on this gateway
                  </p>
                )}
              </div>
            ))}
          </div>
          <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            One block per chain, never summed into a single wallet figure:{' '}
            {networkRows.map((n) => networkLabel(n.network)).join(' and ')} settle
            from different wallets.
          </p>
        </Section>
      )}

      {/* ============================================================
          THE SERIES, AND THE VALUES BEHIND IT.
          ============================================================ */}
      <Section className="mt-4" title="Revenue and commission over time">
        {series.length === 0 ? (
          <ChartEmpty>
            No revenue has been recorded yet. The first confirmed payment starts
            this series.
          </ChartEmpty>
        ) : (
          <>
            {/* Two series, two carriers each. Revenue is emerald and solid;
                commission is slate and DASHED, so the pair stays separable in a
                greyscale print and for a colour-blind reader — the dash is not
                decoration, it is the second carrier. Both inks come from the
                ramp through custom properties rather than as hexes. */}
            <div className={`${MONEY_INK_CLASS} ${SECOND_INK_VARS} ${AXIS_INK_CLASS}`}>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  {/* `X_AXIS_PROPS` is what makes this chart readable under
                      400px, and it is shared rather than spelled out so no
                      console chart can forget it. `minTickGap` drops labels
                      until each has 28px of clearance — without it recharts
                      draws every date whatever the width, and on a phone ninety
                      of them overlap into a grey smear. `preserveStartEnd`
                      guarantees the first and last survive that culling, which
                      are the two the reader needs in order to know what window
                      they are looking at. */}
                  <XAxis dataKey="date" {...X_AXIS_PROPS} />
                  <YAxis
                    tick={{ fontSize: AXIS_TICK_SIZE }}
                    tickLine={false}
                    axisLine={false}
                    // 40, down from 56: on a 320px plot the axis gutter was
                    // taking a sixth of the chart to print four labels.
                    width={Y_AXIS_WIDTH}
                  />
                  <Tooltip
                    content={<ChartTip />}
                    cursor={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke="currentColor"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="commission"
                    stroke="var(--series-2)"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* The key, replacing recharts' `<Legend>`: it carries the WORD and
                the SHAPE, so a series is never a colour on its own — and it now
                carries the most recent value of each series, because on a touch
                device the tooltip that used to be the only route to a number is
                unreachable. */}
            <ChartKey
              items={[
                {
                  label: 'Revenue',
                  swatch: MONEY_INK_SWATCH,
                  note: latest ? `solid · ${formatUsdt(latest.revenue)} on ${latest.date}` : 'solid',
                },
                {
                  label: 'Commission',
                  swatch: SECOND_INK_SWATCH,
                  note: latest
                    ? `dashed · ${formatUsdt(latest.commission)} on ${latest.date}`
                    : 'dashed',
                },
              ]}
            />

            {/* THE LEDGER UNDER THE CHART. Every point the chart draws, as a
                figure that can be read without a pointer — most recent first,
                because "what did we make yesterday" is the question, and the
                left-hand end of a ninety-day line is not the answer. */}
            <div className="mt-5">
              <DataTable
                columns={seriesColumns}
                rows={series}
                rowKey={(p) => p.date}
                label="Revenue and commission by day"
                emptyMessage="No days in this series."
                defaultSortKey="date"
                defaultSortDir="desc"
                pageSize={7}
                renderMobile={seriesMobileRow}
              />
            </div>
          </>
        )}
      </Section>

      {/* ============================================================
          BY MERCHANT. A ranked ledger, not a donut: the question is
          "who pays us, and how much", and that is a column of figures.
          ============================================================ */}
      <Section className="mt-4" flush title="By merchant">
        <DataTable
          columns={clientColumns}
          rows={breakdown}
          rowKey={(c) => c.clientId}
          emptyMessage="No merchant has generated commission yet."
          emptyHint="A merchant appears here after their first confirmed payment."
          label="Volume and commission by merchant"
          defaultSortKey="commission"
          defaultSortDir="desc"
          pageSize={15}
          renderMobile={(c) => (
            <div className="flex items-start justify-between gap-3">
              <span className="min-w-0 truncate font-medium text-slate-900 dark:text-slate-50">
                {c.clientName}
              </span>
              <span className="min-w-0 shrink-0 text-right">
                {/* `break-words` on both figures: a truncated amount is silent
                    data loss, and the column is allowed to grow instead. */}
                <span className="amount-in block break-words text-sm">
                  {formatUsdt(c.commission)} USDT
                </span>
                <span className="num block break-words text-xs text-slate-500 dark:text-slate-400">
                  {formatUsdt(c.volume)} USDT volume
                </span>
                {topCommission > 0 && (
                  <span className="num block text-xs text-slate-500 dark:text-slate-400">
                    {(((Number(c.commission) || 0) / topCommission) * 100).toFixed(0)}% of top
                  </span>
                )}
              </span>
            </div>
          )}
        />
        <p className="measure-wide pb-1 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Sorted by commission earned. The bar is each merchant against the top
          earner, not against the total — on a long tail a share-of-total bar is
          one pixel wide for everyone below third.
        </p>
      </Section>
    </>
  );
}
