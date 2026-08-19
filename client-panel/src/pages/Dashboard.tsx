import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
import {
  CheckCircle2,
  Clock,
  Link2,
  PlusCircle,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { errorMessage, getAnalytics, getOnboarding, listPayments } from '@/lib/api';
import { formatAmount, formatDate, formatDateShort } from '@/lib/format';
import type { AnalyticsAssetRow, Payment } from '@/types';
import StatCard from '@/components/StatCard';
import PageHeader from '@/components/PageHeader';
import ErrorState from '@/components/ErrorState';
import DataTable from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import OnboardingChecklist from '@/components/OnboardingChecklist';
import BalanceStrip from '@/components/BalanceStrip';
import Sparkline from '@/components/Sparkline';
import Section, { MoreLink } from '@/components/Section';
import { PaymentStatusBadge } from '@/components/Badge';
import {
  AXIS_INK_CLASS,
  AXIS_TICK_SIZE,
  STATUS_GROUPS,
  VOLUME_INK_CLASS,
  statusGroupOf,
} from '@/lib/chartTheme';
import type { StatusGroupId } from '@/lib/chartTheme';

/**
 * THE FRONT PAGE.
 *
 * Set as a broadsheet at working density: one enormous figure carrying the
 * spread, a ledger strip of supporting figures beside it, then ruled bands of
 * real data. Not a grid of equal cards — a page where four numbers are all the
 * same size is a page where none of them is the point.
 *
 * NOTHING ANIMATES ON MOUNT. That includes recharts, which does not obey CSS:
 * `<Area>` and `<Pie>` both default to `isAnimationActive`, so the area used to
 * draw itself over 1500ms and the donut used to sweep in, every single time a
 * merchant opened the page. Both are switched off below and must stay off.
 *
 * THE NON-FUNGIBILITY DISCIPLINE is the correctness rule on this page. Nothing
 * here sums across a (network, asset) pair: the headline is a 30-day FLOW,
 * explicitly labelled approximate and explicitly not a balance; the withdrawable
 * figures are BalanceStrip, which refuses to total; and the per-asset ledger is
 * one row per pair with the ticker printed on every amount.
 */

/* ------------------------------------------------------------------ *
 * Page furniture
 * ------------------------------------------------------------------ */

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
 * recharts' default tooltip is a hardcoded white box with a hardcoded shadow —
 * which is why the old `contentStyle` carried `rgba(15,23,42,0.18)` and rendered
 * white-on-white text in dark mode. This is a normal element with normal
 * classes, so it grounds and flips like everything else. Each datum carries its
 * own pre-formatted `tipHead`/`tipValue`, so formatting lives with the data and
 * neither chart needs a bespoke formatter.
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

/* ------------------------------------------------------------------ *
 * Ledger columns. Module scope: a fresh array on every render would
 * invalidate DataTable's sort memo on every render.
 * ------------------------------------------------------------------ */

/**
 * ASSET AND NETWORK ARE ONE LABEL, never two facts. "1,204.50 USDT" is not an
 * answer to "what settled"; "1,204.50 USDT on BEP20" is. The volume column
 * repeats the ticker for the same reason — these rows are never summed, so a
 * bare number in the column would invite exactly the addition the whole page
 * refuses to do.
 */
const assetColumns: Column<AnalyticsAssetRow>[] = [
  {
    key: 'pair',
    header: 'Asset · Network',
    sortValue: (r) => `${r.asset} ${r.network}`,
    render: (r) => (
      <span className="font-medium text-slate-900 dark:text-slate-100">
        {r.asset} · {r.network}
      </span>
    ),
  },
  {
    key: 'count',
    header: 'Payments',
    numeric: true,
    sortValue: (r) => r.count,
    render: (r) => r.count,
  },
  {
    key: 'volume',
    header: 'Volume',
    numeric: true,
    sortValue: (r) => Number(r.volume),
    render: (r) => (
      <span className="amount-in">
        {formatAmount(Number(r.volume))} {r.asset}
      </span>
    ),
  },
];

/**
 * The per-asset row, stacked. It had no `renderMobile` and fell back to the
 * generic title + definition-list layout, which is the right default and the
 * wrong shape for three fields: ~110px a row, so six pairs cost 730px on a
 * phone. The pair, its count and its volume fit on two lines.
 */
function assetMobileRow(r: AnalyticsAssetRow) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate text-[13.5px] font-medium text-slate-900 dark:text-slate-100">
        {r.asset} · {r.network}
      </span>
      <span className="shrink-0 text-right">
        <span className="amount-in block text-[13.5px]">
          {formatAmount(Number(r.volume))} {r.asset}
        </span>
        <span className="num block text-[11.5px] text-slate-500 dark:text-slate-400">
          {r.count} {r.count === 1 ? 'payment' : 'payments'}
        </span>
      </span>
    </div>
  );
}

const paymentAmount = (p: Payment) => Number(p.amountReceived || p.amount || 0);

const paymentColumns: Column<Payment>[] = [
  {
    key: 'orderId',
    header: 'Order',
    sortValue: (p) => p.orderId,
    render: (p) => (
      // A real anchor as well as a clickable row: the row handler is a
      // convenience, the link is what makes middle-click and "open in new tab"
      // work. `stopPropagation` keeps a plain click from navigating twice.
      <Link
        to={`/payments/${p.paymentId}`}
        onClick={(e) => e.stopPropagation()}
        className="block max-w-[18rem] truncate font-medium text-slate-900 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-100"
      >
        {p.orderId}
      </Link>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    hideOnMobile: true,
    sortValue: (p) => p.createdAt,
    render: (p) => (
      <span className="num text-slate-500 dark:text-slate-400">
        {formatDate(p.createdAt)}
      </span>
    ),
  },
  {
    key: 'amount',
    header: 'Amount',
    numeric: true,
    sortValue: paymentAmount,
    render: (p) => formatAmount(paymentAmount(p)),
  },
  {
    key: 'pair',
    header: 'Asset · Network',
    hideOnMobile: true,
    render: (p) => (
      <span className="text-slate-500 dark:text-slate-400">
        {p.asset ?? p.currency} · {p.network}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    align: 'right',
    render: (p) => <PaymentStatusBadge status={p.status} />,
  },
];

/**
 * Below `md` the five-column ledger becomes a stacked, ruled list — two lines a
 * column, so the row costs ~72px rather than the ~98px a third line for the
 * status badge used to add. Set at the ledger's own 13.5px: this is a table row
 * wearing a different layout, not body copy.
 */
function paymentMobileRow(p: Payment) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Link
          to={`/payments/${p.paymentId}`}
          onClick={(e) => e.stopPropagation()}
          className="block truncate text-[13.5px] font-medium text-slate-900 hover:underline dark:text-slate-100"
        >
          {p.orderId}
        </Link>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="num text-[11.5px] text-slate-500 dark:text-slate-400">
            {formatDate(p.createdAt)}
          </span>
          <PaymentStatusBadge status={p.status} />
        </span>
      </div>
      <div className="min-w-0 shrink-0 text-right">
        <p className="num text-[13.5px] font-medium text-slate-900 dark:text-slate-100">
          {formatAmount(paymentAmount(p))}
        </p>
        <p className="text-[11.5px] text-slate-500 dark:text-slate-400">
          {p.asset ?? p.currency} · {p.network}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Dashboard() {
  const navigate = useNavigate();

  // Aggregates come from the SERVER. The page used to pull 500 payments and sum
  // them here, which was correct for a quiet account and understated for a busy
  // one — and grew the payload with the merchant's success.
  const analyticsQuery = useQuery({
    queryKey: ['analytics', 30],
    queryFn: () => getAnalytics(30),
  });

  // Still fetched, but only for the "recent payments" list — a small page, not
  // the basis of any figure.
  const paymentsQuery = useQuery({
    queryKey: ['payments', 'dashboard-recent'],
    queryFn: () => listPayments({ limit: 6 }),
  });
  // Drives the setup checklist below the header. A failure here must not take
  // the dashboard down, so it is never surfaced as an error state — an absent
  // result simply means no checklist.
  const onboardingQuery = useQuery({
    queryKey: ['onboarding'],
    queryFn: getOnboarding,
    retry: false,
  });

  // Charts are shorter on a phone. A 240px plot is a third of a 748px viewport
  // spent on fourteen points, and the same series reads fine at 180. Measured
  // once at mount rather than on resize: a chart that re-measures while the
  // address bar collapses is a layout thrash for no gain.
  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
  const chartH = narrow ? 180 : 240;
  const donutH = narrow ? 165 : 190;

  const recent: Payment[] = paymentsQuery.data?.data ?? [];
  const a = analyticsQuery.data;
  const loading = analyticsQuery.isLoading;
  const totals = a?.totals;

  // Charts take numbers; the API sends strings to preserve numeric(38,18)
  // precision. Converting HERE, at the edge, is deliberate — a chart axis does
  // not need full precision and nothing downstream reconciles against these.
  const volumeSeries = useMemo(
    () =>
      (a?.timeseries ?? []).slice(-14).map((b) => ({
        date: b.date.slice(5),
        volume: Number(b.volume),
        tipHead: b.date,
        tipValue: `≈ ${formatAmount(Number(b.volume))} USD · ${b.count} ${
          b.count === 1 ? 'payment' : 'payments'
        }`,
      })),
    [a],
  );

  /**
   * Statuses grouped onto the four MEANINGS before they are drawn — see
   * lib/chartTheme.ts. A pie needs one colour per slice to be readable at all,
   * and this palette has four state inks, so the alternative was seven
   * decorative hues that disagreed with the badges in the table below.
   *
   * Nothing is lost: each group prints its member statuses and their own counts
   * in the key beside the chart.
   */
  const statusGroups = useMemo(() => {
    const acc = new Map<StatusGroupId, { count: number; members: string[] }>();
    for (const s of a?.byStatus ?? []) {
      const id = statusGroupOf(s.status);
      const entry = acc.get(id) ?? { count: 0, members: [] };
      entry.count += s.count;
      entry.members.push(`${s.status} ${s.count}`);
      acc.set(id, entry);
    }
    const total = [...acc.values()].reduce((n, e) => n + e.count, 0);

    return STATUS_GROUPS.filter((g) => (acc.get(g.groupId)?.count ?? 0) > 0).map((g) => {
      const entry = acc.get(g.groupId)!;
      const share = total > 0 ? (entry.count / total) * 100 : 0;
      return {
        ...g,
        value: entry.count,
        share,
        members: entry.members.join(' · '),
        tipHead: g.label,
        tipValue: `${entry.count} ${entry.count === 1 ? 'payment' : 'payments'} · ${share.toFixed(0)}%`,
      };
    });
  }, [a]);

  if (analyticsQuery.isError) {
    return (
      <>
        <PageHeader eyebrow="Overview" title="Dashboard" />
        <ErrorState
          message={(analyticsQuery.error as { message?: string })?.message}
          onRetry={() => analyticsQuery.refetch()}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="Your payment activity across every asset you accept."
        actions={
          <>
            <Link to="/payment-links" className="btn-secondary">
              <Link2 size={16} />
              {/* The label used to be hidden below `sm`, back when this button
                  shrink-wrapped to its icon and space was the constraint. The
                  action row stretches its children on a phone now, so hiding it
                  buys nothing and costs the label: a 168px button containing a
                  lone chain glyph. */}
              New link
            </Link>
            <Link to="/payments/new" className="btn-primary">
              <PlusCircle size={16} />
              New payment
            </Link>
          </>
        }
        meta={
          a ? (
            <>
              {formatDateShort(a.range.from)} – {formatDateShort(a.range.to)} · updated{' '}
              {new Date(analyticsQuery.dataUpdatedAt).toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </>
          ) : undefined
        }
      />

      {onboardingQuery.data && !onboardingQuery.data.complete && (
        <div className="mb-4">
          <OnboardingChecklist state={onboardingQuery.data} />
        </div>
      )}

      {/* ============================================================
          THE METRIC GRID.
          `auto-fit` + `minmax` rather than a fixed column count: the tiles
          reflow from four across to one without a single breakpoint, and —
          more importantly — a tile can never be squeezed below the width its
          figure needs. `minmax(0, 1fr)` on the track is what allows the
          `break-words` inside StatCard to work at all, since a grid item
          defaults to `min-width: auto` and refuses to shrink under its
          content.

          The lead tile spans two columns. A row of five identical boxes states
          five numbers at identical weight, so none of them is the point; this
          page has exactly one headline figure and it should look like it.
          ============================================================ */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] sm:gap-3">
        <StatCard
          wide
          label="Received · last 30 days"
          value={
            <>
              ≈ {formatAmount(Number(totals?.settledVolumeApprox ?? 0))}{' '}
              <span className="text-[0.5em] font-semibold text-slate-500 dark:text-slate-400">
                USD
              </span>
            </>
          }
          loading={loading}
          delta={totals?.volumeChangePct ?? null}
          deltaLabel={
            totals && totals.volumeChangePct !== null
              ? `against ≈ ${formatAmount(Number(totals?.previousSettledVolumeApprox ?? 0))} in the 30 days before`
              : 'no earlier period to compare'
          }
        >
          {/* The sparkline is the tile's own body, not a second chart: it says
              "this is the shape of that number" in 44px, and the full series is
              one section down for anyone who wants to read it. */}
          {volumeSeries.length > 1 && <Sparkline points={volumeSeries.map((p) => p.volume)} />}
        </StatCard>

        <StatCard
          label="Settled payments"
          value={totals?.settledCount ?? 0}
          icon={TrendingUp}
          loading={loading}
          sub={`${totals?.partialCount ?? 0} partial · ${totals?.expiredCount ?? 0} expired`}
        />
        <StatCard
          label="In flight"
          value={`≈ ${formatAmount(Number(totals?.inFlightAmountApprox ?? 0))}`}
          icon={Clock}
          tone="amber"
          loading={loading}
          sub={`USD · ${totals?.inFlightCount ?? 0} awaiting confirmation`}
        />
        <StatCard
          label="Success rate"
          value={`${(totals?.successRate ?? 0).toFixed(1)}%`}
          icon={CheckCircle2}
          loading={loading}
          sub="Confirmed against finished"
        />
        <StatCard
          label="Failed"
          value={totals?.failedCount ?? 0}
          icon={XCircle}
          // Red is the ink for money that failed — so it is only spent when
          // something actually did. A red glyph over a zero is a false alarm.
          tone={(totals?.failedCount ?? 0) > 0 ? 'red' : undefined}
          loading={loading}
          sub="In the last 30 days"
        />
      </div>

      {/* THE CAVEAT, stated once and next to the figure it qualifies rather
          than three sections away. This is a FLOW, not a balance. */}
      <p className="measure-wide mt-3 px-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The headline is USD, approximate across every asset you accept. Assets are
        not fungible across chains, so it is what arrived — not what you can
        withdraw. The balances below are that figure, and{' '}
        <Link to="/reports" className="link-ink">
          Reports
        </Link>{' '}
        is where you reconcile.
      </p>

      {/* ============================================================
          BALANCES. Immediately under the headline, because the headline is
          explicitly NOT one. BalanceStrip refuses to total, and says so on
          screen.
          ============================================================ */}
      <Section
        className="mt-4"
        title="Balances · per network and asset"
        aside={<MoreLink to="/payouts">Payouts</MoreLink>}
      >
        <BalanceStrip />
      </Section>

      {/* ============================================================
          CHARTS. Two surfaces on a 3-column grid — the series gets two, the
          composition gets one, because a 14-point series needs the width and
          a four-slice donut does not.
          ============================================================ */}
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <Section className="lg:col-span-2" title="Volume received · last 14 days">
          {loading ? (
            <span className="ghost w-full opacity-60" style={{ height: chartH }} aria-hidden />
          ) : volumeSeries.length === 0 ? (
            <p className="measure py-16 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Nothing has settled in this period yet. The first confirmed payment
              starts this series.
            </p>
          ) : (
            /* `color` is set HERE so the stroke and the gradient stops can both
               ask for `currentColor` — a documented recharts prop rather than a
               reach into its DOM — and follow the theme with no JS. The axis ink
               is the one class that has to reach in; see lib/chartTheme.ts. */
            <div className={`${VOLUME_INK_CLASS} ${AXIS_INK_CLASS}`}>
              <ResponsiveContainer width="100%" height={chartH}>
                <AreaChart data={volumeSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="currentColor" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="currentColor" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/*
                    `minTickGap` is what makes this chart readable under 400px.
                    Without it recharts draws all fourteen date labels whatever
                    the width, so on a phone they overlap into a grey smear and
                    the axis stops being an axis. With it, recharts drops labels
                    until each has 28px of clearance — fewer ticks, all legible.
                    `preserveStartEnd` guarantees the first and last dates
                    survive that culling, which are the two the reader needs to
                    know what window they are looking at.
                  */}
                  <XAxis
                    dataKey="date"
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
                    // 40 rather than 48: on a 320px plot the axis gutter was
                    // taking an eighth of the chart to print four labels.
                    width={40}
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
                    fill="url(#vol)"
                    // The dashboard's motion budget: no entrance, ever.
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Section>

        <Section title="Payment status · last 30 days">
          {loading ? (
            <span className="ghost w-full opacity-60" style={{ height: donutH }} aria-hidden />
          ) : statusGroups.length === 0 ? (
            <p className="measure py-16 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              No payments yet.
            </p>
          ) : (
            <>
              <div className={AXIS_INK_CLASS}>
                <ResponsiveContainer width="100%" height={donutH}>
                  <PieChart>
                    <Pie
                      data={statusGroups}
                      dataKey="value"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius="58%"
                      outerRadius="92%"
                      paddingAngle={2}
                      // recharts' default sector stroke is a hardcoded white,
                      // which drew white hairlines between slices on the dark
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

              {/* The key, replacing recharts' <Legend>: it carries the WORD, the
                  count and the share, so the slice colour never has to be read
                  on its own, and it names every underlying status. This is also
                  the only way the values are reachable on a touch device, where
                  a hover tooltip is not. */}
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
                        <span className="block text-xs leading-snug text-slate-500 dark:text-slate-400">
                          {g.members}
                        </span>
                      </span>
                    </span>
                    <span className="num shrink-0 pt-0.5 text-right text-sm text-slate-700 dark:text-slate-300">
                      {g.value}
                      <span className="text-slate-400"> · {g.share.toFixed(0)}%</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>

      {/* ============================================================
          PER-ASSET SETTLEMENT. The authoritative breakdown: one row per
          (network, asset), never summed, because a merchant holding USDT on
          BEP20 and USDT on TRC20 does not hold one combined number of anything.
          ============================================================ */}
      {(loading || (a?.byAsset.length ?? 0) > 0) && (
        <Section
          className="mt-4"
          flush
          title="Settled by asset · last 30 days"
          aside={<MoreLink to="/reports">Reports</MoreLink>}
        >
          <DataTable
            columns={assetColumns}
            rows={a?.byAsset ?? []}
            rowKey={(r) => `${r.network}:${r.asset}`}
            loading={loading}
            skeletonRows={3}
            renderMobile={assetMobileRow}
            label="Settled volume by asset and network"
            emptyLabel="Nothing has settled in the last 30 days."
          />
          <p className="measure-wide pb-1 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            One row per network and asset, never summed — each pair settles from
            its own wallet.
          </p>
        </Section>
      )}

      {/* ============================================================
          RECENT ACTIVITY. The dashboard used to end at the charts, which meant
          the most common question — "did that payment land?" — needed a second
          navigation to answer.
          ============================================================ */}
      <Section
        className="mt-4"
        flush
        title="Recent payments"
        aside={<MoreLink to="/payments">View all</MoreLink>}
      >
        <DataTable
          columns={paymentColumns}
          rows={recent}
          rowKey={(p) => p.paymentId}
          loading={paymentsQuery.isLoading}
          // The list used to fall through to "No payments yet" when the request
          // FAILED, which told a merchant with a full account that they had
          // never taken a payment.
          error={paymentsQuery.isError ? errorMessage(paymentsQuery.error) : null}
          onRetry={() => paymentsQuery.refetch()}
          skeletonRows={6}
          renderMobile={paymentMobileRow}
          onRowClick={(p) => navigate(`/payments/${p.paymentId}`)}
          label="Recent payments"
          emptyLabel="No payments yet."
          emptyHint="Create one from here, or share a payment link — send a small amount yourself to watch the whole lifecycle."
          emptyAction={
            <Link to="/payments/new" className="btn-primary">
              <PlusCircle size={16} /> Create a payment
            </Link>
          }
        />
      </Section>
    </>
  );
}
