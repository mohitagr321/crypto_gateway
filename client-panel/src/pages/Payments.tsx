import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink, PlusCircle, Search } from 'lucide-react';
import { explorerTx, listPayments } from '@/lib/api';
import { ALL_STATUSES, formatAmount, formatDate, shortHash } from '@/lib/format';
import type { Payment, PaymentStatus } from '@/types';
import PageHeader from '@/components/PageHeader';
import { AssetBadge } from '@/components/AssetPicker';
import DataTable, { type Column } from '@/components/DataTable';
import { PaymentStatusBadge } from '@/components/Badge';
import CopyButton from '@/components/CopyButton';

const PAGE_SIZE = 25;

export default function Payments() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<PaymentStatus | ''>('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: ['payments', 'list', status, page],
    queryFn: () => listPayments({ status, page, limit: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    const data = query.data?.data ?? [];
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter(
      (p) =>
        p.orderId.toLowerCase().includes(q) ||
        p.paymentId.toLowerCase().includes(q) ||
        (p.txHash ?? '').toLowerCase().includes(q),
    );
  }, [query.data, search]);

  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns: Column<Payment>[] = [
    {
      key: 'orderId',
      header: 'Order',
      render: (p) => (
        <Link
          to={`/payments/${p.paymentId}`}
          className="font-medium text-brand-600 hover:underline dark:text-brand-400"
        >
          {p.orderId}
        </Link>
      ),
    },
    {
      key: 'paymentId',
      header: 'Payment ID',
      hideOnMobile: true,
      render: (p) => (
        <span className="flex items-center gap-1 font-mono text-xs">
          {shortHash(p.paymentId, 8, 4)}
          <CopyButton value={p.paymentId} size={12} />
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (p) => (
        <span className="flex items-center gap-2">
          <span className="font-medium tabular-nums">{formatAmount(p.amount)}</span>
          <AssetBadge asset={p.asset ?? p.currency} network={p.network} />
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => <PaymentStatusBadge status={p.status} />,
    },
    {
      key: 'txHash',
      header: 'Tx',
      hideOnMobile: true,
      render: (p) =>
        p.txHash ? (
          <a
            href={explorerTx(p.txHash, p.network)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 hover:underline dark:text-brand-400"
          >
            {shortHash(p.txHash)}
            <ExternalLink size={11} />
          </a>
        ) : (
          <span className="text-slate-400">—</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      hideOnMobile: true,
      render: (p) => (
        <span className="whitespace-nowrap text-xs text-slate-500">
          {formatDate(p.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Payments"
        description="Full transaction history with filters."
        actions={
          <Link to="/payments/new" className="btn-primary">
            <PlusCircle size={16} /> Create
          </Link>
        }
      />

      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pl-9"
            placeholder="Search order / payment ID / tx hash…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="input sm:w-56"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as PaymentStatus | '');
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.paymentId}
          loading={query.isLoading}
          error={query.isError ? (query.error as { message?: string })?.message : null}
          onRetry={() => query.refetch()}
          onRowClick={(p) => navigate(`/payments/${p.paymentId}`)}
          emptyLabel="No payments match your filters."
        />

        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm dark:border-slate-800">
            <span className="text-slate-500">
              Page {page} of {totalPages} · {total} total
            </span>
            <div className="flex gap-2">
              <button
                className="btn-secondary"
                disabled={page <= 1 || query.isFetching}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                className="btn-secondary"
                disabled={page >= totalPages || query.isFetching}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
