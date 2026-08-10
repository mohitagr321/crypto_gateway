import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import Badge, { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import PageHeader from '@/components/PageHeader';
import { apiErrorMessage, listClients, listTransactions } from '@/lib/api';
import { formatDate, formatUsdt, shortHash, txLink } from '@/lib/format';
import type { Transaction, TransactionFilters } from '@/types';

const PAYMENT_STATUSES = ['waiting', 'confirming', 'confirmed', 'partial', 'failed', 'expired', 'swept'];

/**
 * THE GLOBAL LEDGER — every on-chain movement, every merchant.
 *
 * The filters are a row of fields ON the page, closed by the ledger's own ink
 * rule a few lines below, rather than a bordered "Filters" card sitting above a
 * bordered table. Two enclosures to say "these controls belong to that table" is
 * one enclosure more than the rule already says.
 *
 * WHAT IS SERVER-SIDE IS STATED. Every control here is a request; the column
 * sorts and the paging underneath are client-side over what came back. An
 * operator who sorts by amount and reads off "the largest sweep today" deserves
 * to know which of those two they are looking at.
 */
export default function Transactions() {
  const [filters, setFilters] = useState<TransactionFilters>({});

  const clientsQuery = useQuery({ queryKey: ['clients'], queryFn: () => listClients() });

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['transactions', filters],
    queryFn: () => listTransactions(filters),
  });

  const clients = clientsQuery.data?.data ?? [];
  const rows = data?.data ?? [];
  const filtered = Object.keys(filters).length > 0;

  const columns: Column<Transaction>[] = useMemo(
    () => [
      {
        key: 'createdAt',
        header: 'Date',
        sortValue: (t) => t.createdAt,
        render: (t) => (
          <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">
            {formatDate(t.createdAt)}
          </span>
        ),
      },
      {
        key: 'client',
        header: 'Client',
        sortValue: (t) => t.clientName ?? '',
        render: (t) => (
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {t.clientName ?? shortHash(t.clientId, 6, 4)}
          </span>
        ),
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
        hideOnMobile: true,
        sortValue: (t) => t.network ?? 'BEP20',
        render: (t) => <NetworkLabel network={t.network} />,
      },
      {
        key: 'amount',
        header: 'Amount',
        // Ranged right on tabular figures: a money column that is not `numeric`
        // is a bug you can see from across the room.
        numeric: true,
        sortValue: (t) => Number(t.amount ?? 0),
        render: (t) => (
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {formatUsdt(t.amount)}
            <span className="font-normal text-slate-500 dark:text-slate-400">
              {' '}
              {t.currency ?? 'USDT'}
            </span>
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
        numeric: true,
        hideOnMobile: true,
        render: (t) =>
          t.confirmations ?? <span className="text-slate-500 dark:text-slate-400">—</span>,
      },
      {
        key: 'tx',
        header: 'Tx hash',
        hideOnMobile: true,
        render: (t) =>
          t.txHash ? (
            <a
              href={txLink(t.txHash, t.network)}
              target="_blank"
              rel="noreferrer"
              // The row does not navigate, but the link leaves the app — keep the
              // click from bubbling anywhere it might later.
              onClick={(e) => e.stopPropagation()}
              className="link-ink inline-flex items-center gap-1 font-mono text-xs"
            >
              {shortHash(t.txHash)} <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">not seen yet</span>
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
      <PageHeader
        eyebrow="Monitoring"
        title="Transactions"
        subtitle="Every deposit, sweep, payout and commission movement the gateway has seen."
        meta={
          isLoading
            ? undefined
            : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}${
                isFetching ? ' · updating' : ''
              }`
        }
      />

      <div className="mb-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="tx-status">
              Status
            </label>
            <select
              id="tx-status"
              className="input"
              value={filters.status ?? ''}
              onChange={(e) => update({ status: e.target.value })}
            >
              <option value="">All statuses</option>
              {PAYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tx-client">
              Client
            </label>
            <select
              id="tx-client"
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
            <label className="label" htmlFor="tx-from">
              From
            </label>
            <input
              id="tx-from"
              type="date"
              className="input"
              value={filters.from ?? ''}
              onChange={(e) => update({ from: e.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor="tx-to">
              To
            </label>
            <input
              id="tx-to"
              type="date"
              className="input"
              value={filters.to ?? ''}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        </div>
        {filtered && (
          <div className="mt-3">
            <button type="button" className="btn-secondary !py-1.5" onClick={() => setFilters({})}>
              Clear filters
            </button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(t) => t.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        onRetry={() => refetch()}
        emptyMessage={
          filtered
            ? 'No transactions match these filters.'
            : 'No transactions recorded yet.'
        }
        emptyHint={
          filtered
            ? 'Every filter above is asked of the server, so this is the whole result — not a page of it.'
            : 'A row lands here the moment a deposit is seen on-chain.'
        }
        emptyAction={
          filtered ? (
            <button type="button" className="btn-secondary" onClick={() => setFilters({})}>
              Clear filters
            </button>
          ) : undefined
        }
        label="Transactions"
        defaultSortKey="createdAt"
        defaultSortDir="desc"
        maxHeight="70vh"
        skeletonRows={10}
        pageSize={15}
        renderMobile={(t) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900 dark:text-slate-50">
                {t.clientName ?? shortHash(t.clientId, 6, 4)}
              </p>
              <p className="mt-0.5 text-xs capitalize text-slate-500 dark:text-slate-400">
                {t.type} · {formatDate(t.createdAt)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="num text-sm font-medium text-slate-900 dark:text-slate-50">
                {formatUsdt(t.amount)} {t.currency ?? 'USDT'}
              </p>
              <span className="mt-1 flex justify-end">
                <Badge status={String(t.status)} />
              </span>
            </div>
          </div>
        )}
      />

      <p className="measure-wide mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The four filters above are asked of the server. Column sorting and the
        paging below the ledger reorder what came back — they do not go looking
        for more.
      </p>
    </>
  );
}
