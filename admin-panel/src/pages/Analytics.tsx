import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Coins, TrendingUp } from 'lucide-react';
import { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import { BandHead, Figure, ShareBar } from '@/components/Editorial';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
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
} from '@/components/Chart';
import Spinner from '@/components/Spinner';
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
 */
export default function Analytics() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => analytics(),
  });

  const series = useMemo(
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

  if (isLoading) return <Spinner label="Loading analytics…" />;
  if (isError || !data) {
    return (
      <>
        <PageHeader
          eyebrow="Overview"
          title="Analytics"
          subtitle="Revenue and commission breakdown"
        />
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const networkRows = data.networkBreakdown ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Analytics"
        subtitle="What the gateway earned, which chain it came over, and which merchants it came from."
      />

      {/* ============================================================
          THE SPREAD. One enormous figure — what the business actually
          made — against the two figures that put it in context.
          ============================================================ */}
      <section className="grid gap-x-10 gap-y-8 lg:grid-cols-12">
        <div className="rule pt-3 lg:col-span-5">
          <span className="runhead">Total commission earned</span>
          <Figure size="xl" className="mt-2 truncate">
            {formatUsdt(data.totalCommission)}
          </Figure>
          <p className="figure-label measure">
            USDT, every merchant and every chain, for the whole life of the
            gateway. It is held per chain and is only withdrawable from the chain
            it was earned on — Revenue is where that split lives.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2 lg:col-span-7">
          <StatCard
            label="Total revenue"
            value={formatUsdt(data.totalRevenue)}
            icon={Coins}
            tone="emerald"
            hint="USDT recognised as gateway income"
          />
          <StatCard
            label="Total volume"
            value={formatUsdt(data.totalVolume)}
            icon={TrendingUp}
            hint="USDT processed on behalf of merchants"
          />
        </div>
      </section>

      {/* ============================================================
          PER CHAIN. The totals above are chain-agnostic — one business
          — but volume per chain is what tells you which hot wallet is
          filling up and which one has to stay funded. A chain with no
          volume is still listed, so one that was expected to be earning
          and isn't is visible rather than absent.
          ============================================================ */}
      {networkRows.length > 0 && (
        <section className="mt-10">
          <BandHead>Volume by chain</BandHead>
          <div className="mt-2 grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
            {networkRows.map((n) => (
              <div key={n.network} className="rule pt-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <NetworkLabel network={n.network} full />
                  {!n.enabled && (
                    // Not a failure — a chain the gateway is not currently
                    // settling on. Slate, and the word carries it.
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      disabled on this gateway
                    </span>
                  )}
                </div>
                <Figure className="mt-1.5 truncate">{formatUsdt(n.volume)}</Figure>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  USDT · {n.count} payment{n.count === 1 ? '' : 's'} ·{' '}
                  <span className="num">{formatUsdt(n.commission)}</span> USDT commission
                </p>
              </div>
            ))}
          </div>
          <p className="measure-wide mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            One column per chain, never summed into a single wallet figure:{' '}
            {networkRows.map((n) => networkLabel(n.network)).join(' and ')} settle
            from different wallets.
          </p>
        </section>
      )}

      {/* ============================================================
          THE SERIES.
          ============================================================ */}
      <section className="mt-10">
        <BandHead>Revenue and commission over time</BandHead>
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
            <div className={`mt-4 ${MONEY_INK_CLASS} ${SECOND_INK_VARS} ${AXIS_INK_CLASS}`}>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: AXIS_TICK_SIZE }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: AXIS_TICK_SIZE }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
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
            {/* The key, replacing recharts' <Legend>: it carries the WORD, so a
                series name is never a colour on its own. */}
            <ChartKey
              items={[
                { label: 'Revenue', swatch: MONEY_INK_SWATCH, note: 'solid' },
                { label: 'Commission', swatch: SECOND_INK_SWATCH, note: 'dashed' },
              ]}
            />
          </>
        )}
      </section>

      {/* ============================================================
          BY MERCHANT. A ranked ledger, not a donut: the question is
          "who pays us, and how much", and that is a column of figures.
          ============================================================ */}
      <section className="mt-10">
        <BandHead>By merchant</BandHead>
        <div className="mt-3">
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
                <span className="shrink-0 text-right">
                  <span className="amount-in block text-sm">
                    {formatUsdt(c.commission)} USDT
                  </span>
                  <span className="num block text-xs text-slate-500 dark:text-slate-400">
                    {formatUsdt(c.volume)} USDT volume
                  </span>
                </span>
              </div>
            )}
          />
        </div>
        <p className="measure-wide mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Sorted by commission earned. The bar is each merchant against the top
          earner, not against the total — on a long tail a share-of-total bar is
          one pixel wide for everyone below third.
        </p>
      </section>
    </>
  );
}
