import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileBarChart } from 'lucide-react';
import { listPayments } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import {
  downloadCsv,
  formatAmount,
  formatDate,
} from '@/lib/format';
import type { Payment } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import { PaymentStatusBadge } from '@/components/Badge';
import StatCard from '@/components/StatCard';

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

  const totals = useMemo(() => {
    const settled = filtered.filter(
      (p) => p.status === 'confirmed' || p.status === 'swept',
    );
    const volume = settled.reduce(
      (s, p) => s + Number(p.amountReceived || p.amount || 0),
      0,
    );
    return { count: filtered.length, settledCount: settled.length, volume };
  }, [filtered]);

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

  const columns: Column<Payment>[] = [
    { key: 'orderId', header: 'Order', render: (p) => p.orderId },
    {
      key: 'amount',
      header: 'Amount',
      render: (p) => `${formatAmount(p.amount)} ${p.currency}`,
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => <PaymentStatusBadge status={p.status} />,
    },
    {
      key: 'createdAt',
      header: 'Created',
      hideOnMobile: true,
      render: (p) => (
        <span className="text-xs text-slate-500">{formatDate(p.createdAt)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        description="Filter by date range and export your payment data as CSV."
        actions={
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={filtered.length === 0}
          >
            <Download size={16} /> Download CSV
          </button>
        }
      />

      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
        <div>
          <label className="label" htmlFor="from">
            From
          </label>
          <input
            id="from"
            type="date"
            className="input"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="to">
            To
          </label>
          <input
            id="to"
            type="date"
            className="input"
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
            7d
          </button>
          <button
            className="btn-secondary"
            onClick={() => {
              setFrom(daysAgoStr(30));
              setTo(todayStr());
            }}
          >
            30d
          </button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Payments in range"
          value={totals.count}
          icon={FileBarChart}
          tone="blue"
          loading={query.isLoading}
        />
        <StatCard
          label="Settled"
          value={totals.settledCount}
          tone="emerald"
          loading={query.isLoading}
        />
        <StatCard
          label="Settled volume"
          value={`${formatAmount(totals.volume)} USDT`}
          tone="brand"
          loading={query.isLoading}
        />
      </div>

      <div className="card">
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(p) => p.paymentId}
          loading={query.isLoading}
          error={query.isError ? errorMessage(query.error) : null}
          onRetry={() => query.refetch()}
          emptyLabel="No payments in this date range."
        />
      </div>
    </>
  );
}
