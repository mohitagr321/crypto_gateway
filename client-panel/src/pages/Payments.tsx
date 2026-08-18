import { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ExternalLink, PlusCircle, Search } from 'lucide-react';
import { explorerTx, listPayments } from '@/lib/api';
import { ALL_STATUSES, formatAmount, formatDate, shortHash } from '@/lib/format';
import type { Payment, PaymentStatus } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import Section from '@/components/Section';
import { PaymentStatusBadge } from '@/components/Badge';
import CopyButton from '@/components/CopyButton';

const PAGE_SIZE = 25;

/**
 * THE LIST — a merchant's money-in ledger.
 *
 * TWO SURFACES, IN THE ORDER THE WORK HAPPENS: narrow the set, then read it.
 * The filter bar is a raised surface of its own and the ledger is a titled
 * Section below it, rather than both being printed straight onto the page. A row
 * of controls floating on the bare canvas is the single clearest tell of an
 * unfinished screen — there is nothing to say where the instrument ends and the
 * data begins, so the eye has to work it out from the copy.
 *
 * Inside the ledger nothing changed: hairlines still divide the rows and the
 * amount column is still ranged right on tabular figures, so magnitudes can be
 * compared down the column instead of read one at a time. What changed is that
 * those hairlines now divide WITHIN a surface rather than carrying the page's
 * whole structure. See the LEDGER block in index.css.
 *
 * ASSET AND NETWORK ARE ONE COLUMN, never two and never one without the other:
 * USDT on BEP20 and USDT on TRC20 are different assets with different addresses,
 * and a row that names only the symbol is a row that can be misread into a
 * cross-network mistake. The amount is split off into its own numeric column so
 * the decimal points stack — the pair travels with it as a label, not as a
 * pill, because a column of tinted rectangles fights the hairlines.
 *
 * WHAT IS SERVER-SIDE AND WHAT IS NOT is stated on the page. The status filter
 * and the pagination are requests; the search box and the column sorts only
 * touch the rows already on screen. A merchant who searches an order id from
 * three weeks ago and gets "no matches" deserves to know they searched one page
 * of twenty-five, so the footnote under the ledger says so rather than leaving
 * them to infer it.
 *
 * MOTION: none added. Rows tint on hover (120ms, colour only, from the
 * primitive) and nothing else moves — this is a screen that gets opened dozens
 * of times a day.
 */
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

  const pageRows = query.data?.data ?? [];

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
  const searching = search.trim().length > 0;
  const filtered = searching || status !== '';

  const clearFilters = () => {
    setSearch('');
    setStatus('');
    setPage(1);
  };

  const columns: Column<Payment>[] = [
    {
      key: 'orderId',
      header: 'Order',
      // The merchant's own reference, and the identity of the row — which is
      // why it is the column worth freezing when the ledger scrolls sideways.
      // Ink with a brand underline rather than brand text: brand marks the
      // thing you can click, it does not colour a whole column of them.
      sortValue: (p) => p.orderId,
      render: (p) => (
        <Link to={`/payments/${p.paymentId}`} className="link-ink font-medium">
          {p.orderId}
        </Link>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      // Ranged right on tabular figures by the primitive. A money column that
      // is not `numeric` is a bug you can see from across the room.
      numeric: true,
      sortValue: (p) => Number(p.amount),
      render: (p) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatAmount(p.amount)}
        </span>
      ),
    },
    {
      key: 'asset',
      header: 'Asset',
      render: (p) => <AssetOnNetwork asset={p.asset ?? p.currency} network={p.network} />,
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
      sortValue: (p) => Date.parse(p.createdAt) || 0,
      render: (p) => (
        <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDate(p.createdAt)}
        </span>
      ),
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
            // The row navigates; this link leaves the app. Without this the
            // merchant gets both.
            onClick={(e) => e.stopPropagation()}
            // `break-all` even though `shortHash` has already elided the middle:
            // a hash is one unbreakable token, so if the column is ever narrower
            // than the elision the cell sets its own minimum width and drags the
            // whole ledger sideways rather than wrapping.
            className="link-ink inline-flex items-center gap-1 break-all font-mono text-xs"
          >
            {shortHash(p.txHash)}
            <ExternalLink size={11} className="shrink-0" aria-hidden />
          </a>
        ) : (
          // Never a bare dash: say which nothing this is.
          <span className="text-slate-500 dark:text-slate-400">not seen yet</span>
        ),
    },
    {
      key: 'paymentId',
      header: 'Payment ID',
      hideOnMobile: true,
      render: (p) => (
        // `whitespace-nowrap` was the wrong instrument here and the audit caught
        // it: an id is an unbreakable token, so refusing to wrap it made this
        // cell — not the data — the thing setting the ledger's minimum width.
        // `break-all` lets it fold instead, and the copy control is pinned so it
        // never wraps away from the value it copies.
        <span className="flex items-center gap-1 font-mono text-xs text-slate-500 dark:text-slate-400">
          <span className="min-w-0 break-all">{shortHash(p.paymentId, 8, 4)}</span>
          {/* Copying used to navigate as well: the click bubbled to the row
              handler, so "copy this id" opened the record every time. */}
          <span className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <CopyButton value={p.paymentId} size={12} />
          </span>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Money in"
        title="Payments"
        description="Every payment your account has been asked for, settled or not."
        actions={
          <Link to="/payments/new" className="btn-primary">
            <PlusCircle size={16} aria-hidden /> Create
          </Link>
        }
        meta={
          query.isLoading ? undefined : (
            <>
              {total.toLocaleString()} payment{total === 1 ? '' : 's'}
              {status && ` · ${status}`}
              {query.isFetching && ' · updating'}
            </>
          )
        }
      />

      {/* ============================================================
          THE FILTER BAR, ON ITS OWN SURFACE.

          It used to be a bare row of fields on the page, which read as
          unfinished for a reason worth stating: a control needs a ground to
          sit on before it reads as a control. Given one, the bar also becomes
          a single object the eye can dismiss once it has been set, rather than
          three loose fields it has to re-parse on the way down to the data.

          NOT a `.spot`, and not `.glass`. Glass belongs to chrome that floats
          over the page (topbar, dock, modals); a filter bar scrolls with the
          content and is therefore plane 2, the same plane as the ledger under
          it. The controls stay stacked below `sm` exactly as they were.
          ============================================================ */}
      <div className="surface p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              className="input pl-9"
              placeholder="Search order / payment ID / tx hash…"
              aria-label="Search this page of payments"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input sm:w-56"
            aria-label="Filter by status"
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
          {filtered && (
            <button type="button" className="btn-secondary shrink-0" onClick={clearFilters}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* `flush` because the body is a ledger: a table ranges to the edges of
          its own surface, and body padding would inset the rows from the rules
          that divide them. The footnote and the pager below share that padding,
          so they line up with the columns rather than with the surface edge. */}
      <Section className="mt-3" flush title="Payments">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.paymentId}
          loading={query.isLoading}
          error={query.isError ? (query.error as { message?: string })?.message : null}
          onRetry={() => query.refetch()}
          onRowClick={(p) => navigate(`/payments/${p.paymentId}`)}
          label="Payments"
          // Column one is the row's identity, so it is worth freezing when the
          // seven columns run wider than the viewport.
          stickyFirstColumn
          // The only thing that makes the header actually stick: without a height
          // the scroll box never scrolls and the header pins to nothing.
          //
          // `dvh`, NOT `vh`. On mobile Safari `vh` is measured against the tall
          // viewport the page has before the URL bar collapses, so `70vh` is
          // meaningfully more than 70% of what the merchant can actually see —
          // and this box is already nested inside the shell's own scroller,
          // where being too tall means the inner scrollbar never appears and the
          // sticky header goes back to sticking to nothing.
          maxHeight="70dvh"
          // Enough ghost rows to fill the box, so nothing jumps when data lands.
          skeletonRows={10}
          renderMobile={(p) => (
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                {/* `break-words`, not `truncate`. An order id is the merchant's
                    own reference and the only thing identifying the row; half of
                    one is worse than a second line. It breaks only where it has
                    to, so an ordinary reference still sets on one line. */}
                <span className="block break-words font-medium text-slate-900 dark:text-slate-50">
                  {p.orderId}
                </span>
                <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
                  {formatDate(p.createdAt)}
                </span>
              </span>
              {/* `min-w-0` rather than `shrink-0`: a money figure must never be
                  clipped by its own column, so the amount side yields width and
                  wraps instead of overflowing the row. */}
              <span className="min-w-0 text-right">
                <span className="num lining-nums block break-words font-medium text-slate-900 dark:text-slate-50">
                  {formatAmount(p.amount)}
                </span>
                <span className="mt-0.5 block text-xs">
                  <AssetOnNetwork asset={p.asset ?? p.currency} network={p.network} />
                </span>
                <span className="mt-1.5 block">
                  <PaymentStatusBadge status={p.status} />
                </span>
              </span>
            </div>
          )}
          emptyLabel={
            filtered
              ? 'No payments on this page match these filters.'
              : 'No payments yet.'
          }
          emptyHint={
            filtered
              ? `The status filter asks the server; the search box only looks at the ${PAGE_SIZE} rows on this page.`
              : 'A payment appears here as soon as one is created — from the API, a payment link, or the Create button above.'
          }
          emptyAction={
            filtered ? (
              <button type="button" className="btn-secondary" onClick={clearFilters}>
                Clear filters
              </button>
            ) : (
              <Link to="/payments/new" className="btn-secondary">
                Create a payment
              </Link>
            )
          }
        />

        {/* The footnote and the pager, inside the ledger's own surface rather
            than adrift under it. A rule still divides them from the last row —
            that is what a hairline is FOR now: dividing within a surface, not
            standing in for one. Suppressed on an error, where the ledger's own
            frame is already saying what happened. */}
        {!query.isError && (
          <div className="rule mt-3 flex flex-col-reverse gap-3 pb-1 pt-3 sm:flex-row sm:items-baseline sm:justify-between">
            <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {searching && !query.isLoading && (
                <>
                  <span className="num">{rows.length}</span> of{' '}
                  <span className="num">{pageRows.length}</span> rows on this page match.{' '}
                </>
              )}
              Search and column sorting apply to this page only; the status filter and
              paging are asked of the server.
            </p>

            {total > PAGE_SIZE && (
              <nav
                className="flex shrink-0 flex-wrap items-center gap-3"
                aria-label="Pagination"
              >
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={page <= 1 || query.isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={page >= totalPages || query.isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </button>
              </nav>
            )}
          </div>
        )}
      </Section>
    </>
  );
}

/**
 * The pair, never one half of it. Set as one label rather than a symbol plus a
 * tinted network pill: the pill was a box in a page made of rules, and it read
 * as a second status colour down the column.
 */
function AssetOnNetwork({ asset, network }: { asset: string; network: string }) {
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-slate-800 dark:text-slate-200">{asset}</span>
      <span className="text-slate-500 dark:text-slate-400"> · {network}</span>
    </span>
  );
}
