import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';
import Badge, { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import { apiErrorMessage, listClients, listTransactions } from '@/lib/api';
import { formatDate, formatUsdt, shortHash, txLink } from '@/lib/format';
import type { Transaction, TransactionFilters } from '@/types';

const PAYMENT_STATUSES = ['waiting', 'confirming', 'confirmed', 'partial', 'failed', 'expired', 'swept'];

/**
 * THE GLOBAL LEDGER — every on-chain movement, every merchant.
 *
 * TWO SURFACES, IN THE ORDER THEY ARE USED: the filters you set, then the rows
 * they returned. That replaces the outgoing shape, which was a bare row of
 * fields printed onto the page above a bare table — four controls floating on
 * the canvas with nothing saying they belonged to the ledger under them except
 * proximity. On a surface-based page a control with no surface under it reads as
 * unfinished, and the reader has to infer the grouping the layout should be
 * stating.
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
        // `dot` is explicit now that Badge defaults it off — a row-level status
        // readout is exactly what the lit mark is for, and it is what carries
        // the in-flight pulse down a column of forty rows.
        render: (t) => <Badge status={String(t.status)} dot />,
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
        description="Every deposit, sweep, payout and commission movement the gateway has seen."
        meta={
          isLoading
            ? undefined
            : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}${
                isFetching ? ' · updating' : ''
              }`
        }
      />

      {/* ============================================================
          THE FILTERS, ON THEIR OWN SURFACE. Everything below the head is a
          reading of whatever these four controls say, so they are grouped and
          raised rather than printed on the bare canvas.

          `auto-fit` rather than `sm:grid-cols-2 lg:grid-cols-4`: the fields
          reflow from four across to one without a breakpoint, and no field can
          ever be squeezed below the width a date input needs — which on iOS is
          the difference between a usable control and an unreadable stub.

          The `aside` carries a fact, never a control — that is the rule the
          merchant panel's sections are written to, and it is what keeps every
          section head in the product one predictable height.
          ============================================================ */}
      <Section
        title="Filters"
        aside={
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {filtered
              ? `${Object.keys(filters).length} applied · asked of the server`
              : 'Asked of the server'}
          </span>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-3">
          <div className="min-w-0">
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
          <div className="min-w-0">
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
          <div className="min-w-0">
            <label className="label" htmlFor="tx-from">
              From
            </label>
            <input
              id="tx-from"
              type="date"
              className="input num"
              value={filters.from ?? ''}
              onChange={(e) => update({ from: e.target.value })}
            />
          </div>
          <div className="min-w-0">
            <label className="label" htmlFor="tx-to">
              To
            </label>
            <input
              id="tx-to"
              type="date"
              className="input num"
              value={filters.to ?? ''}
              onChange={(e) => update({ to: e.target.value })}
            />
          </div>
        </div>

        {/* Full size, no `!py-1.5`. That override computed to a ~36px control,
            and `.btn` now carries the 44px floor itself — the override bought
            nothing except a target a thumb misses. */}
        {filtered && (
          <button type="button" className="btn-secondary mt-3" onClick={() => setFilters({})}>
            Clear filters
          </button>
        )}
      </Section>

      {/* `flush`, because a table ranges to the edges of its own surface —
          body padding would inset the rows from the rules that divide them. */}
      <Section className="mt-4" flush title="Movements">
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
          // `dvh`, never `vh`: on mobile Safari `vh` measures the viewport
          // WITHOUT the collapsing toolbar, so a `70vh` cap is taller than 70%
          // of what the operator can actually see.
          maxHeight="70dvh"
          skeletonRows={10}
          pageSize={15}
          /**
           * THE STACKED ROW. Three of the eight columns are `hideOnMobile`, and
           * one of them — the transaction hash — is the answer to the only
           * question worth opening this page on a phone for: did it actually
           * land on chain. It used to be dropped entirely below `md`, so an
           * operator away from their desk could see that a sweep existed and
           * had no way to check it. It now sits on its own line under the row,
           * at the 44px touch floor, with the chain printed beside it because a
           * hash without its network is a link to the wrong explorer.
           */
          renderMobile={(t) => (
            <div>
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
                  {/* `break-words`, never `truncate`, on anything holding an
                      amount: a cut figure is read wrong rather than noticed. */}
                  <p className="num break-words text-sm font-medium text-slate-900 dark:text-slate-50">
                    {formatUsdt(t.amount)} {t.currency ?? 'USDT'}
                  </p>
                  <span className="mt-1 flex justify-end">
                    <Badge status={String(t.status)} dot />
                  </span>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs">
                <NetworkLabel network={t.network} />
                {t.txHash ? (
                  <a
                    href={txLink(t.txHash, t.network)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="link-ink inline-flex min-h-[44px] items-center gap-1 font-mono"
                  >
                    {shortHash(t.txHash)} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : (
                  <span className="inline-flex min-h-[44px] items-center text-slate-500 dark:text-slate-400">
                    not seen yet
                  </span>
                )}
                {t.confirmations != null && (
                  <span className="num text-slate-500 dark:text-slate-400">
                    {t.confirmations} conf.
                  </span>
                )}
              </div>
            </div>
          )}
        />

        <p className="measure-wide pb-1 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          The four filters above are asked of the server. Column sorting and the
          paging below the ledger reorder what came back — they do not go looking
          for more.
        </p>
      </Section>
    </>
  );
}
