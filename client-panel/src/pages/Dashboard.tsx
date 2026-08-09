import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  Clock,
  Link2,
  PlusCircle,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { getAnalytics, getOnboarding, listPayments } from '@/lib/api';
import { formatAmount } from '@/lib/format';
import type { Payment } from '@/types';
import StatCard from '@/components/StatCard';
import PageHeader from '@/components/PageHeader';
import ErrorState from '@/components/ErrorState';
import { LoadingPanel } from '@/components/Spinner';
import OnboardingChecklist from '@/components/OnboardingChecklist';
import BalanceStrip from '@/components/BalanceStrip';
import { PaymentStatusBadge } from '@/components/Badge';

/**
 * Chart colours are the SEMANTIC palette, not the brand ramp — these encode
 * payment state, so they must agree with the status badges in Badge.tsx. A
 * merchant should never see one green in the table and a different green in the
 * chart for the same status.
 *
 * `confirmed` was hardcoded to the old brand green (#22a06b) here and in the
 * area chart's gradient; both now use emerald, which is what "money arrived"
 * means everywhere else in the product.
 */
const STATUS_COLORS: Record<string, string> = {
  confirmed: '#059669', // emerald-600  — money arrived
  swept: '#4f46e5', // brand indigo — moved to collection
  waiting: '#f59e0b', // amber        — waiting on the customer
  confirming: '#0ea5e9', // sky        — in flight
  partial: '#a855f7', // purple       — needs a decision
  failed: '#dc2626', // red          — money failed
  expired: '#94a3b8', // slate        — nothing happened
};

/** Volume is money received, so the area chart is emerald, not brand. */
const VOLUME_COLOR = '#059669';

export default function Dashboard() {
  // Aggregates come from the SERVER now. The page used to pull 500 payments and
  // sum them here, which was correct for a quiet account and understated for a
  // busy one — and grew the payload with the merchant's success.
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

  // Charts take numbers; the API sends strings to preserve numeric(38,18)
  // precision. Converting HERE, at the edge, is deliberate — a chart axis does
  // not need full precision and nothing downstream reconciles against these.
  const volumeSeries = useMemo(
    () =>
      (a?.timeseries ?? []).slice(-14).map((b) => ({
        date: b.date.slice(5),
        volume: Number(b.volume),
      })),
    [a],
  );

  const statusBreakdown = useMemo(
    () => (a?.byStatus ?? []).map((s) => ({ name: s.status, value: s.count })),
    [a],
  );

  if (analyticsQuery.isError) {
    return (
      <>
        <PageHeader title="Dashboard" />
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
      />

      {onboardingQuery.data && !onboardingQuery.data.complete && (
        <div className="mb-6">
          <OnboardingChecklist state={onboardingQuery.data} />
        </div>
      )}

      {/* Per-asset balances first: with several assets a single "available"
          figure would be a number the merchant can never withdraw in one payout,
          because balances are not fungible across assets or chains. */}
      <div className="mb-6">
        <BalanceStrip />
      </div>

      {/* NOTE ON THE TOTALS: these sum ACROSS assets, so they are labelled
          "≈ USD" rather than any one ticker. Every asset the gateway settles is
          a USD stablecoin, which makes the sum a fair approximation — but it is
          not a balance and must not be presented as one. The withdrawable,
          per-asset figures are the BalanceStrip above. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Received · 30d"
          value={`≈ ${formatAmount(Number(a?.totals.settledVolumeApprox ?? 0))} USD`}
          icon={ArrowDownToLine}
          tone="emerald"
          loading={loading}
          delta={a?.totals.volumeChangePct ?? null}
          deltaLabel="vs previous 30 days"
        />
        <StatCard
          label="Settled payments"
          value={a?.totals.settledCount ?? 0}
          icon={TrendingUp}
          tone="brand"
          loading={loading}
          sub={`${a?.totals.partialCount ?? 0} partial · ${a?.totals.expiredCount ?? 0} expired`}
        />
        <StatCard
          label="In flight"
          value={`≈ ${formatAmount(Number(a?.totals.inFlightAmountApprox ?? 0))} USD`}
          icon={Clock}
          tone="amber"
          loading={loading}
          sub={`${a?.totals.inFlightCount ?? 0} awaiting confirmation`}
        />
        <StatCard
          label="Success rate"
          value={`${(a?.totals.successRate ?? 0).toFixed(1)}%`}
          icon={CheckCircle2}
          tone="blue"
          loading={loading}
          sub="Confirmed vs finished"
        />
      </div>

      {/* The cross-asset caveat, stated once and plainly. These headline figures
          sum assets that are not fungible; the per-asset table below and the
          balance strip above are the numbers that mean money. */}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Totals are approximate across assets and are not a withdrawable balance.
        See per-asset figures below, or{' '}
        <Link to="/reports" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Reports
        </Link>{' '}
        to reconcile.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Volume received · last 14 days
          </h2>
          {loading ? (
            <LoadingPanel />
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={volumeSeries}>
                <defs>
                  <linearGradient id="vol" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={VOLUME_COLOR} stopOpacity={0.32} />
                    <stop offset="95%" stopColor={VOLUME_COLOR} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: 'none',
                    fontSize: 12,
                    boxShadow: '0 8px 24px rgba(15,23,42,0.18)',
                  }}
                  formatter={(v: number) => [`≈ ${formatAmount(v)} USD`, 'Volume']}
                />
                <Area
                  type="monotone"
                  dataKey="volume"
                  stroke={VOLUME_COLOR}
                  strokeWidth={2}
                  fill="url(#vol)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Status breakdown
          </h2>
          {loading ? (
            <LoadingPanel />
          ) : statusBreakdown.length === 0 ? (
            <p className="py-16 text-center text-sm text-slate-400">
              No payments yet.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={statusBreakdown}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={52}
                  outerRadius={86}
                  paddingAngle={2}
                >
                  {statusBreakdown.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name] ?? '#94a3b8'} />
                  ))}
                </Pie>
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  iconType="circle"
                  formatter={(v) => (
                    <span className="text-slate-600 dark:text-slate-300">{v}</span>
                  )}
                />
                <Tooltip
                  contentStyle={{ borderRadius: 10, border: 'none', fontSize: 12 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Per-asset settled volume. This is the authoritative breakdown: one row
          per (network, asset), never summed, because a merchant holding USDT on
          BEP20 and BTC does not hold a single combined number of anything. */}
      {(a?.byAsset.length ?? 0) > 0 && (
        <div className="card mt-5 overflow-hidden">
          <div className="border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Settled by asset · last 30 days
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-5 py-2.5 font-semibold">Asset</th>
                  <th className="px-5 py-2.5 font-semibold">Network</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Payments</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Volume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {a!.byAsset.map((row) => (
                  <tr key={`${row.network}-${row.asset}`}>
                    <td className="px-5 py-3 font-medium text-slate-800 dark:text-slate-100">
                      {row.asset}
                    </td>
                    <td className="px-5 py-3 text-slate-600 dark:text-slate-400">
                      {row.network}
                    </td>
                    <td className="num px-5 py-3 text-right text-slate-600 dark:text-slate-400">
                      {row.count}
                    </td>
                    <td className="amount-in px-5 py-3 text-right">
                      {formatAmount(Number(row.volume))} {row.asset}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent activity. The dashboard used to end at the charts, which meant
          the most common question — "did that payment land?" — needed a second
          navigation to answer. */}
      <div className="card mt-5 overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Recent payments
          </h2>
          <Link
            to="/payments"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 transition hover:gap-1.5 dark:text-brand-400"
          >
            View all <ArrowRight size={13} />
          </Link>
        </div>

        {paymentsQuery.isLoading ? (
          <div className="p-5">
            <LoadingPanel />
          </div>
        ) : recent.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800">
              <Wallet size={20} />
            </span>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              No payments yet
            </p>
            <p className="max-w-sm text-xs text-slate-500 dark:text-slate-400">
              Create one from the dashboard, or share a payment link — you can
              send a small amount yourself to watch the whole lifecycle.
            </p>
            <Link to="/payments/new" className="btn-primary mt-2">
              <PlusCircle size={16} /> Create a payment
            </Link>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {recent.map((p) => (
              <li key={p.paymentId}>
                <Link
                  to={`/payments/${p.paymentId}`}
                  className="flex items-center gap-4 px-5 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {p.orderId}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {new Date(p.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="hidden text-right sm:block">
                    <p className="num text-sm font-medium text-slate-800 dark:text-slate-100">
                      {formatAmount(Number(p.amountReceived || p.amount || 0))}
                    </p>
                    <p className="text-xs text-slate-400">
                      {p.asset ?? p.currency} · {p.network}
                    </p>
                  </div>
                  <PaymentStatusBadge status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
