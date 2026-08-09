import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Badge from '@/components/Badge';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
import StatCard from '@/components/StatCard';
import { DollarSign, PieChart as PieIcon, TrendingUp } from 'lucide-react';
import { analytics, apiErrorMessage } from '@/lib/api';
import { formatUsdt, networkTone } from '@/lib/format';
import { useTheme } from '@/context/ThemeContext';

const PIE_COLORS = ['#1f9968', '#7c3aed', '#2563eb', '#d97706', '#dc2626', '#0891b2', '#db2777', '#65a30d'];

export default function Analytics() {
  const { theme } = useTheme();
  const grid = theme === 'dark' ? '#1f2937' : '#e5e7eb';
  const axis = theme === 'dark' ? '#9ca3af' : '#6b7280';

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => analytics(),
  });

  if (isLoading) return <Spinner label="Loading analytics…" />;
  if (isError || !data) {
    return (
      <>
        <PageHeader title="Analytics" subtitle="Revenue and commission breakdown" />
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      </>
    );
  }

  const tooltipStyle = {
    backgroundColor: theme === 'dark' ? '#111827' : '#ffffff',
    border: `1px solid ${grid}`,
    borderRadius: 8,
    fontSize: 12,
    color: theme === 'dark' ? '#f3f4f6' : '#111827',
  };

  const breakdown = data.clientBreakdown ?? [];

  return (
    <>
      <PageHeader title="Analytics" subtitle="Revenue and commission breakdown" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total revenue" value={`${formatUsdt(data.totalRevenue)} USDT`} icon={DollarSign} tone="brand" />
        <StatCard label="Total commission" value={`${formatUsdt(data.totalCommission)} USDT`} icon={PieIcon} tone="purple" />
        <StatCard label="Total volume" value={`${formatUsdt(data.totalVolume)} USDT`} icon={TrendingUp} tone="blue" />
      </div>

      {/* Per-chain split. The totals above are chain-agnostic (one business),
          but volume per chain is what tells you which hot wallet is filling up
          and which one has to stay funded. Networks with no volume are still
          listed so a chain that was expected to be earning and isn't is
          visible rather than absent. */}
      {(data.networkBreakdown ?? []).length > 0 && (
        <div className="mt-6 card p-5">
          <h2 className="mb-4 text-sm font-semibold">Volume by network</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(data.networkBreakdown ?? []).map((n) => (
              <div
                key={n.network}
                className="rounded-lg bg-gray-50 p-4 dark:bg-gray-800/50"
              >
                <div className="mb-2 flex items-center gap-2">
                  <Badge tone={networkTone(n.network)}>{n.network}</Badge>
                  {!n.enabled && (
                    <span className="text-xs text-gray-400">disabled on this gateway</span>
                  )}
                </div>
                <p className="text-xl font-semibold tabular-nums">
                  {formatUsdt(n.volume)} USDT
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {n.count} payment{n.count === 1 ? '' : 's'} ·{' '}
                  {formatUsdt(n.commission)} USDT commission
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Revenue vs commission over time</h2>
          <div className="h-72">
            {(data.timeseries ?? []).length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.timeseries} margin={{ left: -12, right: 8, top: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                  <XAxis dataKey="date" tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                  <YAxis tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="revenue" stroke="#1f9968" strokeWidth={2} dot={false} name="Revenue" />
                  <Line type="monotone" dataKey="commission" stroke="#7c3aed" strokeWidth={2} dot={false} name="Commission" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card p-5">
          <h2 className="mb-4 text-sm font-semibold">Commission share by client</h2>
          <div className="h-72">
            {breakdown.length === 0 ? (
              <Empty />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={breakdown}
                    dataKey="commission"
                    nameKey="clientName"
                    innerRadius={55}
                    outerRadius={95}
                    paddingAngle={2}
                  >
                    {breakdown.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => `${formatUsdt(v)} USDT`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 card p-5">
        <h2 className="mb-4 text-sm font-semibold">Volume by client</h2>
        <div className="h-80">
          {breakdown.length === 0 ? (
            <Empty />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={breakdown} margin={{ left: -12, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                <XAxis dataKey="clientName" tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                <YAxis tick={{ fill: axis, fontSize: 11 }} stroke={grid} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(31,153,104,0.08)' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="volume" fill="#2563eb" radius={[4, 4, 0, 0]} name="Volume (USDT)" />
                <Bar dataKey="commission" fill="#7c3aed" radius={[4, 4, 0, 0]} name="Commission (USDT)" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </>
  );
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-gray-400">
      No analytics data available yet.
    </div>
  );
}
