import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Clock, Send, Users } from 'lucide-react';
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
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import { BandHead, Figure, Ghost } from '@/components/Editorial';
import {
  AXIS_INK_CLASS,
  AXIS_TICK_SIZE,
  ChartEmpty,
  ChartTip,
  MONEY_INK_CLASS,
} from '@/components/Chart';
import { analytics, apiErrorMessage } from '@/lib/api';
import { formatUsdt } from '@/lib/format';

/**
 * THE FRONT PAGE OF THE OPERATOR CONSOLE.
 *
 * Set as a broadsheet at working density: ONE enormous figure carrying the
 * spread, a ledger strip of supporting figures beside it, then ruled bands of
 * real data. Not a grid of four equal cards — a page where four numbers are all
 * the same size is a page where none of them is the point, and the point here is
 * how much money the gateway has moved.
 *
 * NOTHING ANIMATES ON MOUNT. That includes recharts, which does not obey CSS:
 * `<Area>` and `<Bar>` both default to `isAnimationActive`, so the area used to
 * draw itself over 1500ms and the bars used to grow out of the axis every single
 * time an operator opened this page. Both are switched off below and must stay
 * off — this is the screen that gets refreshed all day.
 */
export default function Dashboard() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => analytics(),
  });

  // recharts takes numbers; the API sends money as strings to preserve
  // numeric(38,18) precision. Converting HERE, at the edge, is deliberate — a
  // chart axis does not need full precision and nothing downstream reconciles
  // against these.
  const volumeSeries = useMemo(
    () =>
      (data?.timeseries ?? []).map((b) => ({
        date: b.date,
        volume: Number(b.volume),
        tipHead: b.date,
        tipValue: `${formatUsdt(b.volume)} USDT · ${b.count} payment${b.count === 1 ? '' : 's'}`,
      })),
    [data],
  );

  const revenueSeries = useMemo(
    () =>
      (data?.timeseries ?? []).map((b) => ({
        date: b.date,
        revenue: Number(b.revenue),
        tipHead: b.date,
        tipValue: `${formatUsdt(b.revenue)} USDT commission`,
      })),
    [data],
  );

  if (isError) {
    return (
      <>
        <PageHeader eyebrow="Overview" title="Dashboard" subtitle="Gateway activity at a glance" />
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
        subtitle="What the gateway has processed, and what is still waiting on someone."
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
          THE SPREAD. One enormous figure against a ledger strip —
          asymmetric, and both columns open on the same hairline.
          ============================================================ */}
      <section className="grid gap-x-10 gap-y-8 lg:grid-cols-12">
        <div className="rule pt-3 lg:col-span-5">
          <span className="runhead">Total volume processed</span>
          {isLoading ? (
            <Ghost className="mt-4 h-12 w-3/4" />
          ) : (
            <Figure size="xl" className="mt-2 truncate">
              {formatUsdt(data?.totalVolume)}
            </Figure>
          )}
          {/* THE CAVEAT, next to the figure it qualifies rather than three bands
              away. This is a FLOW across every chain the gateway settles on, not
              a balance anyone can spend: what is actually withdrawable sits per
              wallet, per chain, on Wallet balances. */}
          <p className="figure-label measure">
            USDT, across every merchant and every settlement chain. This is what
            moved, not what is held —{' '}
            <Link to="/wallets" className="link-ink">
              Wallet balances
            </Link>{' '}
            is where the money actually is.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-3 lg:col-span-7">
          <StatCard
            label="Active clients"
            value={data?.activeClients ?? 0}
            icon={Users}
            loading={isLoading}
            hint="Merchants able to take payments right now"
          />
          <StatCard
            label="Pending payouts"
            value={data?.pendingPayouts ?? 0}
            icon={Send}
            // Amber only when something is genuinely waiting. An amber glyph
            // over a zero is a false alarm, and an operator who learns to ignore
            // one alarm ignores the next.
            tone={(data?.pendingPayouts ?? 0) > 0 ? 'amber' : 'neutral'}
            loading={isLoading}
            hint={
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
            hint="USDT commission earned since midnight"
          />
        </div>
      </section>

      {/* ============================================================
          THE SERIES. Two bands, each opened by a rule and named by a
          running head — no cards, no enclosure.
          ============================================================ */}
      <section className="mt-10 grid gap-x-10 gap-y-10 xl:grid-cols-2">
        <div className="rule pt-3">
          <BandHead aside={<MoreLink to="/transactions">Transactions</MoreLink>}>
            Volume over time
          </BandHead>
          {isLoading ? (
            <Ghost className="mt-4 h-[260px] w-full opacity-60" />
          ) : !hasSeries ? (
            <ChartEmpty>
              Nothing has settled in this period yet. The first confirmed payment
              starts this series.
            </ChartEmpty>
          ) : (
            /* `color` is set on the WRAPPER so the stroke and both gradient stops
               can ask for `currentColor` — a documented recharts prop rather than
               a reach into its DOM — and follow the theme with no JS. */
            <div className={`mt-4 ${MONEY_INK_CLASS} ${AXIS_INK_CLASS}`}>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={volumeSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="adminVolFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="currentColor" stopOpacity={0.28} />
                      <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
                    </linearGradient>
                  </defs>
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
          )}
          <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            USDT settled per day, every merchant and every chain.
          </p>
        </div>

        <div className="rule pt-3">
          <BandHead aside={<MoreLink to="/revenue">Revenue</MoreLink>}>Revenue over time</BandHead>
          {isLoading ? (
            <Ghost className="mt-4 h-[260px] w-full opacity-60" />
          ) : !hasSeries ? (
            <ChartEmpty>
              No commission has been earned in this period yet.
            </ChartEmpty>
          ) : (
            <div className={`mt-4 ${MONEY_INK_CLASS} ${AXIS_INK_CLASS}`}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={revenueSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
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
          )}
          <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Commission the gateway earned per day, in USDT.
          </p>
        </div>
      </section>
    </>
  );
}

/** "Transactions →", the one repeated affordance on this page. */
function MoreLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-400"
    >
      {children} <ArrowRight size={13} aria-hidden />
    </Link>
  );
}
