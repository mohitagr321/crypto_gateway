import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileBarChart } from 'lucide-react';
import { listPayments } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { downloadCsv, formatAmount, formatDate } from '@/lib/format';
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

/** Asset and network as one label, never two independent facts. */
const pairLabel = (p: Payment) => `${p.asset ?? p.currency} · ${p.network}`;

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

  /**
   * SETTLED VOLUME, PER (NETWORK, ASSET) PAIR — never as one number.
   *
   * This used to reduce every settled payment into a single float and print it
   * with " USDT" welded on the end. On an account that takes both USDT and USDC
   * that figure was 500 + 500 = "1,000.00 USDT": a quantity of a thing the
   * merchant does not have, on the page they would export to reconcile against
   * their books. Assets are not fungible, so volume is grouped exactly the way
   * balances are, and the pair is always named together.
   */
  const totals = useMemo(() => {
    const settled = filtered.filter(
      (p) => p.status === 'confirmed' || p.status === 'swept',
    );

    const pairs = new Map<
      string,
      { network: string; asset: string; total: number; count: number }
    >();
    for (const p of settled) {
      const asset = p.asset ?? p.currency;
      const key = `${p.network}:${asset}`;
      const entry = pairs.get(key) ?? {
        network: p.network,
        asset,
        total: 0,
        count: 0,
      };
      entry.total += Number(p.amountReceived || p.amount || 0);
      entry.count += 1;
      pairs.set(key, entry);
    }

    return {
      count: filtered.length,
      settledCount: settled.length,
      byPair: [...pairs.values()].sort((a, b) => b.total - a.total),
    };
  }, [filtered]);

  // The query asks for one page of 1000. Say so when there is more behind it,
  // rather than letting a merchant reconcile against a silently short report.
  const fetched = query.data?.data.length ?? 0;
  const reportTotal = query.data?.total;
  const truncated = typeof reportTotal === 'number' && reportTotal > fetched;

  const resetToLast30 = () => {
    setFrom(daysAgoStr(30));
    setTo(todayStr());
  };

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
    {
      key: 'orderId',
      header: 'Order',
      sortValue: (p) => p.orderId,
      render: (p) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {p.orderId}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortValue: (p) => Number(p.amount),
      render: (p) => formatAmount(p.amount),
    },
    {
      // What actually arrived — the figure the settled volume above is built
      // from, so the two can be reconciled without opening every payment.
      key: 'amountReceived',
      header: 'Received',
      numeric: true,
      hideOnMobile: true,
      sortValue: (p) => Number(p.amountReceived || 0),
      render: (p) =>
        Number(p.amountReceived || 0) > 0 ? (
          <span className="font-medium text-slate-900 dark:text-slate-50">
            {formatAmount(p.amountReceived)}
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">—</span>
        ),
    },
    {
      key: 'asset',
      header: 'Asset',
      sortValue: (p) => pairLabel(p),
      render: (p) => (
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {pairLabel(p)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      render: (p) => <PaymentStatusBadge status={p.status} />,
    },
    {
      key: 'createdAt',
      header: 'Created',
      hideOnMobile: true,
      align: 'right',
      className: 'num',
      sortValue: (p) => new Date(p.createdAt).getTime(),
      render: (p) => (
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {formatDate(p.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Reporting"
        title="Reports"
        description="Filter by date range and export your payment data as CSV."
        actions={
          <button
            className="btn-primary"
            onClick={handleExport}
            disabled={filtered.length === 0}
          >
            <Download size={16} aria-hidden /> Download CSV
          </button>
        }
        meta={
          query.data
            ? `${filtered.length} payment${filtered.length === 1 ? '' : 's'} · ${from} to ${to}`
            : undefined
        }
      />

      {/* THE RANGE. A ruled control row, not a panel — the controls are the
          instrument the rest of the page is read through. */}
      <section className="rule pt-3">
        <span className="runhead">Date range</span>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-48">
            <label className="label" htmlFor="from">
              From
            </label>
            <input
              id="from"
              type="date"
              className="input num"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="sm:w-48">
            <label className="label" htmlFor="to">
              To
            </label>
            <input
              id="to"
              type="date"
              className="input num"
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
              7 days
            </button>
            <button className="btn-secondary" onClick={resetToLast30}>
              30 days
            </button>
          </div>
        </div>
      </section>

      {/* COUNTS. Ruled columns, not boxes: gap-x-8 so the rules read as
          separate columns rather than as one banded strip. */}
      <div className="mt-10 grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3">
        <StatCard
          label="Payments in range"
          value={totals.count}
          icon={FileBarChart}
          loading={query.isLoading}
          sub="all statuses"
        />
        <StatCard
          label="Settled"
          value={totals.settledCount}
          tone="emerald"
          loading={query.isLoading}
          sub="confirmed or swept"
        />
        <StatCard
          label="Not settled"
          value={totals.count - totals.settledCount}
          tone="amber"
          loading={query.isLoading}
          sub="waiting, partial, expired or failed"
        />
      </div>

      {/* SETTLED VOLUME. One ruled column per (network, asset) pair. */}
      <section className="mt-10">
        <span className="runhead">Settled volume</span>

        {query.isLoading ? (
          <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">
            {[0, 1].map((i) => (
              <div key={i} className="rule pt-3" aria-busy="true">
                <span className="ghost h-3 w-24" aria-hidden />
                <span
                  className="ghost mt-3 h-7 w-2/3"
                  aria-hidden
                  style={{ opacity: 1 - i * 0.35 }}
                />
                <span className="ghost mt-2.5 h-2.5 w-16" aria-hidden />
              </div>
            ))}
            <span className="sr-only" role="status">
              Loading settled volume…
            </span>
          </div>
        ) : totals.byPair.length === 0 ? (
          <div className="rule mt-3 pt-3">
            <p className="measure text-base leading-relaxed text-slate-700 dark:text-slate-300">
              Nothing settled in this range.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-4">
              {totals.byPair.map((pair) => (
                <div
                  key={`${pair.network}:${pair.asset}`}
                  className="rule min-w-0 pt-3"
                >
                  <span className="runhead truncate">
                    {pair.asset} · {pair.network}
                  </span>
                  <p className="figure-lg mt-2 truncate">
                    {formatAmount(pair.total)}
                  </p>
                  <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
                    settled from{' '}
                    <span className="num">{pair.count}</span>{' '}
                    payment{pair.count === 1 ? '' : 's'}
                  </p>
                </div>
              ))}
            </div>
            {totals.byPair.length > 1 && (
              <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Shown per network and asset, never summed — assets are not
                fungible, so a combined figure would be a quantity of something
                you do not hold.
              </p>
            )}
          </>
        )}
      </section>

      {/* THE LEDGER. */}
      <section className="mt-10">
        <div className="rule flex items-baseline justify-between gap-4 pb-3 pt-3">
          <span className="runhead">Payments in range</span>
          {!query.isLoading && !query.isError && filtered.length > 0 && (
            <span className="num text-xs text-slate-500 dark:text-slate-400">
              {filtered.length} row{filtered.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(p) => p.paymentId}
          loading={query.isLoading}
          error={query.isError ? errorMessage(query.error) : null}
          onRetry={() => query.refetch()}
          emptyLabel="No payments in this date range."
          emptyHint="The range filters payments already loaded — widen it to see more."
          emptyAction={
            <button className="btn-secondary" onClick={resetToLast30}>
              Reset to last 30 days
            </button>
          }
          label="Payments in range"
          skeletonRows={8}
          renderMobile={(p) => (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                  {p.orderId}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {pairLabel(p)}
                </p>
                <p className="num mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {formatDate(p.createdAt)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="num lining-nums text-base font-semibold text-slate-900 dark:text-slate-50">
                  {formatAmount(p.amount)}
                </p>
                <div className="mt-1.5 flex justify-end">
                  <PaymentStatusBadge status={p.status} />
                </div>
              </div>
            </div>
          )}
          stickyFirstColumn
          maxHeight="62vh"
        />

        {truncated && (
          <p className="measure-wide mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            This report reads the most recent{' '}
            <span className="num">{fetched}</span> of{' '}
            <span className="num">{reportTotal}</span> payments on the account. A
            range reaching further back than that will be incomplete — narrow the
            range, or pull the full history from the API.
          </p>
        )}
      </section>
    </>
  );
}
