import { useMemo } from 'react';
import type { ReactNode } from 'react';
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
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Link2,
  Minus,
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

/**
 * A band's running head, set in INK.
 *
 * The quiet slate `.runhead` labels a column inside a strip (StatCard,
 * BalanceStrip use it that way); this is one level up — the section of the paper
 * you are in — so it takes the ink step. Same primitive, one utility overriding
 * its colour, rather than a second heading style.
 */
function BandHead({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 className="runhead text-slate-900 dark:text-slate-100">{children}</h2>
      {aside}
    </div>
  );
}

/** "View all →", the one repeated affordance on this page. */
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

/**
 * The period-over-period change on the headline figure.
 *
 * Same contract as StatCard's `Delta`, deliberately: the ARROW follows the SIGN
 * (a fall points down, truthfully) and the COLOUR follows the JUDGEMENT. Received
 * volume is the uninverted case — up is good — so the two agree here. The
 * inverted case (refunds, failures, time-to-settle) lives in StatCard's
 * `invertDelta` and is not reimplemented.
 *
 * NULL IS NOT ZERO. A first period has nothing to compare against, and saying
 * "0%" would invent a baseline that does not exist.
 */
function Change({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span className="text-slate-500 dark:text-slate-400">
        no earlier period to compare
      </span>
    );
  }
  const flat = Math.abs(value) < 0.05;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  const ink = flat
    ? 'text-slate-500 dark:text-slate-400'
    : value > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-red-600 dark:text-red-400';

  return (
    <span className={`inline-flex items-center gap-1 font-medium ${ink}`}>
      <Icon size={14} aria-hidden />
      <span className="num lining-nums">{flat ? '0' : Math.abs(value).toFixed(1)}%</span>
      {/* The word, because colour and an arrow are not enough on their own. */}
      <span>{flat ? 'flat' : value > 0 ? 'up' : 'down'}</span>
    </span>
  );
}

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
    <div className="rounded border border-slate-200 bg-white px-3 py-2 shadow-soft dark:border-slate-700 dark:bg-slate-900">
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

/** Below `md` the five-column ledger becomes a stacked, ruled list. */
function paymentMobileRow(p: Payment) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Link
          to={`/payments/${p.paymentId}`}
          onClick={(e) => e.stopPropagation()}
          className="block truncate font-medium text-slate-900 hover:underline dark:text-slate-100"
        >
          {p.orderId}
        </Link>
        <p className="num mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {formatDate(p.createdAt)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p className="num text-sm font-medium text-slate-900 dark:text-slate-100">
          {formatAmount(paymentAmount(p))}
        </p>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {p.asset ?? p.currency} · {p.network}
        </p>
        <span className="mt-1 flex justify-end">
          <PaymentStatusBadge status={p.status} />
        </span>
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
              <span className="hidden sm:inline">New link</span>
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
        <section className="mb-8">
          <OnboardingChecklist state={onboardingQuery.data} />
        </section>
      )}

      {/* ============================================================
          THE SPREAD. One enormous figure against a ledger strip —
          asymmetric, and the two columns open on the same hairline.
          ============================================================ */}
      <section className="grid gap-x-10 gap-y-8 lg:grid-cols-12">
        <div className="rule pt-3 lg:col-span-6">
          <span className="runhead">Received · last 30 days</span>

          {loading ? (
            <span className="ghost mt-3 h-12 w-3/4" aria-hidden />
          ) : (
            <p className="figure-lg mt-2 truncate text-5xl lg:text-6xl">
              ≈ {formatAmount(Number(totals?.settledVolumeApprox ?? 0))}
            </p>
          )}

          {!loading && (
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500 dark:text-slate-400">
              <Change value={totals?.volumeChangePct ?? null} />
              {totals && totals.volumeChangePct !== null && (
                <span>
                  against{' '}
                  <span className="num">
                    ≈ {formatAmount(Number(totals?.previousSettledVolumeApprox ?? 0))}
                  </span>{' '}
                  in the 30 days before
                </span>
              )}
            </p>
          )}

          {/* THE CAVEAT, stated once and next to the figure it qualifies rather
              than three bands away. This is a flow, not a balance. */}
          <p className="figure-label measure">
            USD, approximate across every asset you accept. Assets are not fungible
            across chains, so this is what arrived — not what you can withdraw. The
            balances below are that figure, and{' '}
            <Link to="/reports" className="link-ink">
              Reports
            </Link>{' '}
            is where you reconcile.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-6 lg:col-span-6">
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
      </section>

      {/* ============================================================
          BALANCES. Immediately under the headline, because the headline
          is explicitly NOT one. BalanceStrip refuses to total, and says
          so on screen.
          ============================================================ */}
      <section className="mt-10">
        <BandHead aside={<MoreLink to="/payouts">Payouts</MoreLink>}>
          Balances · per network and asset
        </BandHead>
        <div className="mt-3">
          <BalanceStrip />
        </div>
      </section>

      {/* ============================================================
          CHARTS.
          ============================================================ */}
      <section className="mt-10 grid gap-x-10 gap-y-10 lg:grid-cols-3">
        <div className="rule pt-3 lg:col-span-2">
          <BandHead>Volume received · last 14 days</BandHead>
          {loading ? (
            <span className="ghost mt-4 h-[240px] w-full opacity-60" aria-hidden />
          ) : volumeSeries.length === 0 ? (
            <p className="measure mt-4 py-16 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Nothing has settled in this period yet. The first confirmed payment
              starts this series.
            </p>
          ) : (
            /* `color` is set HERE so the stroke and the gradient stops can both
               ask for `currentColor` — a documented recharts prop rather than a
               reach into its DOM — and follow the theme with no JS. The axis ink
               is the one class that has to reach in; see lib/chartTheme.ts. */
            <div className={`mt-4 ${VOLUME_INK_CLASS} ${AXIS_INK_CLASS}`}>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={volumeSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
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
                    width={48}
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
        </div>

        <div className="rule pt-3">
          <BandHead>Payment status · last 30 days</BandHead>
          {loading ? (
            <span className="ghost mt-4 h-[200px] w-full opacity-60" aria-hidden />
          ) : statusGroups.length === 0 ? (
            <p className="measure mt-4 py-16 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              No payments yet.
            </p>
          ) : (
            <>
              <div className={`mt-4 ${AXIS_INK_CLASS}`}>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={statusGroups}
                      dataKey="value"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={78}
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
                  on its own, and it names every underlying status. */}
              <ul className="mt-4">
                {statusGroups.map((g) => (
                  <li key={g.groupId} className="rule flex items-start justify-between gap-3 py-2">
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
        </div>
      </section>

      {/* ============================================================
          PER-ASSET SETTLEMENT. The authoritative breakdown: one row per
          (network, asset), never summed, because a merchant holding USDT
          on BEP20 and USDT on TRC20 does not hold one combined number of
          anything.
          ============================================================ */}
      {(loading || (a?.byAsset.length ?? 0) > 0) && (
        <section className="mt-10">
          <BandHead aside={<MoreLink to="/reports">Reports</MoreLink>}>
            Settled by asset · last 30 days
          </BandHead>
          <div className="mt-3">
            <DataTable
              columns={assetColumns}
              rows={a?.byAsset ?? []}
              rowKey={(r) => `${r.network}:${r.asset}`}
              loading={loading}
              skeletonRows={3}
              label="Settled volume by asset and network"
              emptyLabel="Nothing has settled in the last 30 days."
            />
          </div>
          <p className="measure-wide mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            One row per network and asset, never summed — each pair settles from its
            own wallet.
          </p>
        </section>
      )}

      {/* ============================================================
          RECENT ACTIVITY. The dashboard used to end at the charts, which
          meant the most common question — "did that payment land?" —
          needed a second navigation to answer.
          ============================================================ */}
      <section className="mt-10">
        <BandHead aside={<MoreLink to="/payments">View all</MoreLink>}>
          Recent payments
        </BandHead>
        <div className="mt-3">
          <DataTable
            columns={paymentColumns}
            rows={recent}
            rowKey={(p) => p.paymentId}
            loading={paymentsQuery.isLoading}
            // The list used to fall through to "No payments yet" when the
            // request FAILED, which told a merchant with a full account that
            // they had never taken a payment.
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
        </div>
      </section>
    </>
  );
}
