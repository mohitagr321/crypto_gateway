import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Filter } from 'lucide-react';
import { useMemo, useState } from 'react';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import PageHeader from '@/components/PageHeader';
import { apiErrorMessage, listClients, listTransactions } from '@/lib/api';
import { formatDate, formatUsdt, networkTone, shortHash, txLink } from '@/lib/format';
import type { Transaction, TransactionFilters } from '@/types';

const PAYMENT_STATUSES = ['waiting', 'confirming', 'confirmed', 'partial', 'failed', 'expired', 'swept'];

export default function Transactions() {
  const [filters, setFilters] = useState<TransactionFilters>({});

  const clientsQuery = useQuery({ queryKey: ['clients'], queryFn: () => listClients() });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => listTransactions(filters),
  });

  const clients = clientsQuery.data?.data ?? [];

  const columns: Column<Transaction>[] = useMemo(
    () => [
      {
        key: 'createdAt',
        header: 'Date',
        sortValue: (t) => t.createdAt,
        render: (t) => <span className="text-xs text-gray-500">{formatDate(t.createdAt)}</span>,
      },
      {
        key: 'client',
        header: 'Client',
        sortValue: (t) => t.clientName ?? '',
        render: (t) => <span>{t.clientName ?? shortHash(t.clientId, 6, 4)}</span>,
      },
      {
        key: 'type',
        header: 'Type',
        sortValue: (t) => t.type,
        render: (t) => <span className="capitalize">{t.type}</span>,
      },
      {
        key: 'network',
        header: 'Network',
        sortValue: (t) => t.network ?? 'BEP20',
        render: (t) => <Badge tone={networkTone(t.network)}>{t.network ?? 'BEP20'}</Badge>,
      },
      {
        key: 'amount',
        header: 'Amount',
        align: 'right',
        sortValue: (t) => Number(t.amount ?? 0),
        render: (t) => (
          <span className="tabular-nums">
            {formatUsdt(t.amount)} {t.currency ?? 'USDT'}
          </span>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        sortValue: (t) => String(t.status),
        render: (t) => <Badge status={String(t.status)} />,
      },
      {
        key: 'confirmations',
        header: 'Conf.',
        align: 'right',
        render: (t) => <span className="tabular-nums">{t.confirmations ?? '—'}</span>,
      },
      {
        key: 'tx',
        header: 'Tx hash',
        render: (t) =>
          t.txHash ? (
            <a
              href={txLink(t.txHash, t.network)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-brand-600 hover:underline"
            >
              {shortHash(t.txHash)} <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="text-gray-400">—</span>
          ),
      },
    ],
    []
  );

  const update = (patch: Partial<TransactionFilters>) =>
    setFilters((f) => {
      const next = { ...f, ...patch };
      // Strip empty strings so we don't send blank query params.
      (Object.keys(next) as (keyof TransactionFilters)[]).forEach((k) => {
        if (next[k] === '' || next[k] === undefined) delete next[k];
      });
      return next;
    });

  return (
    <>
      <PageHeader title="Transactions" subtitle="Global on-chain payment monitoring" />

      <div className="card mb-4 p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
          <Filter className="h-4 w-4" /> Filters
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Status</label>
            <select
              className="input"
              value={filters.status ?? ''}
              onChange={(e) => update({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Client</label>
            <select
              className="input"
              value={filters.clientId ?? ''}
              onChange={(e) => update({ clientId: e.target.value })}
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">From</label>
            <input
              type="date"
              className="input"
              value={filters.from ?? ''}
              onChange={(e) => update({ from: e.target.value })}
            />
          </div>
          <div>
            <label className="label">To</label>
            <input
              type="date"
              className="input"
              value={filters.to ?? ''}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        </div>
        {Object.keys(filters).length > 0 && (
          <div className="mt-3">
            <button className="btn-ghost text-xs" onClick={() => setFilters({})}>
              Clear filters
            </button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(t) => t.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        emptyMessage="No transactions match these filters."
        pageSize={15}
      />
    </>
  );
}
