import { useQuery } from '@tanstack/react-query';
import { Activity, DollarSign, Send, Users } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import StatCard from '@/components/StatCard';
import { analytics, apiErrorMessage } from '@/lib/api';
import { formatUsdt } from '@/lib/format';
import { useTheme } from '@/context/ThemeContext';

export default function Dashboard() {
  const { theme } = useTheme();
  const grid = theme === 'dark' ? '#1f2937' : '#e5e7eb';
  const axis = theme === 'dark' ? '#9ca3af' : '#6b7280';

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => analytics(),
  });

  if (isError) {
    return (
      <>
        <PageHeader title="Dashboard" subtitle="Overview of gateway activity" />
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const ts = data?.timeseries ?? [];

  const tooltipStyle = {
    backgroundColor: theme === 'dark' ? '#111827' : '#ffffff',
    border: `1px solid ${grid}`,
    borderRadius: 8,
    fontSize: 12,
    color: theme === 'dark' ? '#f3f4f6' : '#111827',
  };

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Overview of gateway activity" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total volume"
          value={`${formatUsdt(data?.totalVolume)} USDT`}
          icon={Activity}
          tone="brand"
          loading={isLoading}
        />
        <StatCard
          label="Active clients"
          value={data?.activeClients ?? 0}
          icon={Users}
          tone="blue"
          loading={isLoading}
        />
        <StatCard
          label="Pending payouts"
          value={data?.pendingPayouts ?? 0}
          icon={Send}
          tone="amber"
          hint={data?.pendingPayoutAmount ? `${formatUsdt(data.pendingPayoutAmount)} USDT queued` : undefined}
          loading={isLoading}
        />
        <StatCard
          label="Today's revenue"
          value={`${formatUsdt(data?.todayRevenue)} USDT`}
          icon={DollarSign}
          tone="purple"
          loading={isLoading}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Volume over time</h2>
          <div className="h-72">
            {isLoading ? (
              <div className="h-full w-full animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
            ) : ts.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={ts} margin={{ left: -12, right: 8, top: 8 }}>
                  <defs>
                    <linearGradient id="volFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#1f9968" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#1f9968" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                  <XAxis dataKey="date" tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                  <YAxis tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area
                    type="monotone"
                    dataKey="volume"
                    stroke="#1f9968"
                    strokeWidth={2}
                    fill="url(#volFill)"
                    name="Volume (USDT)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Revenue over time</h2>
          <div className="h-72">
            {isLoading ? (
              <div className="h-full w-full animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800" />
            ) : ts.length === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ts} margin={{ left: -12, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                  <XAxis dataKey="date" tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                  <YAxis tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(31,153,104,0.08)' }} />
                  <Bar dataKey="revenue" fill="#7c3aed" radius={[4, 4, 0, 0]} name="Revenue (USDT)" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-gray-400">
      No data for this period.
    </div>
  );
}
