import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { classNames } from '@/lib/format';
import { Ghost } from './Editorial';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** How to render the cell. */
  render: (row: T) => ReactNode;
  /** Value used for client-side sorting. Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  className?: string;
  align?: 'left' | 'right' | 'center';
  /**
   * MONEY, AND ANYTHING ELSE READ AS A QUANTITY. Ranges the column right — so
   * the decimal points stack and the eye can compare magnitudes down the column
   * instead of reading every figure — and sets tabular lining numerals on the
   * cell and its header together.
   *
   * A money column that is not marked `numeric` is a bug you can see from across
   * the room: 1,240.00 and 9.50 start at the same left edge and look the same
   * size.
   */
  numeric?: boolean;
  /** Drop below `md`, where the ledger would otherwise have to be dragged. */
  hideOnMobile?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  /** Shown under the empty message — say what to do, not just that there is nothing. */
  emptyHint?: ReactNode;
  /** A control that resolves the empty state. */
  emptyAction?: ReactNode;
  onRetry?: () => void;
  /** Rows per page. Client-side, over the rows this table was handed. */
  pageSize?: number;
  onRowClick?: (row: T) => void;
  /** Column key to sort by on first render. */
  defaultSortKey?: string;
  defaultSortDir?: 'asc' | 'desc';
  /** Ghost rows drawn while loading. Match the page size actually rendered. */
  skeletonRows?: number;
  /** Names the scroll region for screen readers and for the keyboard scroller. */
  label?: string;
  /**
   * Cap the ledger's height and let it scroll inside that box.
   *
   * THIS IS THE ONLY THING THAT MAKES THE STICKY HEADER ACTUALLY STICK. A box
   * that scrolls sideways is a vertical scroll container too — the spec coerces
   * overflow-y to auto/hidden the moment overflow-x is auto — so a sticky header
   * inside it resolves against THAT box rather than against the page. With no
   * height limit the box never scrolls and the header sticks to nothing, which
   * is exactly what shipped before. Opt-in per page: worth it on a long list,
   * pointless on a five-row summary.
   */
  maxHeight?: string;
  /**
   * Stacked fallback for narrow screens. When supplied, the table is replaced
   * below `md` by a ruled list of these, which beats making an operator drag a
   * seven-column ledger sideways on a phone.
   */
  renderMobile?: (row: T) => ReactNode;
}

/**
 * The table every list page renders — set as a LEDGER.
 *
 * Hairline rules between rows, a running head over an ink rule for the header,
 * money ranged right on tabular figures, and no enclosure at all: the table is
 * placed ON the page rather than inside a card. A financial table is the one
 * place a hairline beats a card outright — rows are separated by a stroke, the
 * header sits above an ink rule like the top rule of an account book, and the
 * ~24px of padding a card charges on all four sides is bought back as rows of
 * data. Zebra striping is what you reach for when the row rule is missing; with
 * the rule there it is just noise that also breaks selection highlighting.
 *
 * This is the same ledger the merchant panel renders, drawn with utilities
 * rather than through the `.ledger` block in its stylesheet, because
 * src/index.css is out of bounds for this phase. Same treatment, same measures.
 *
 * SORTING AND PAGING ARE BOTH CLIENT-SIDE and only ever touch the rows this
 * component was handed. Where the page itself asks the API for a subset (the
 * transaction filters, the webhook `success` flag), that is stated on the page —
 * an operator who sorts by amount and reads off "the largest payout" deserves to
 * know whether they are looking at the largest of all of them or the largest of
 * fifteen.
 */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage = 'No records found.',
  emptyHint,
  emptyAction,
  onRetry,
  pageSize = 10,
  onRowClick,
  defaultSortKey,
  defaultSortDir = 'asc',
  skeletonRows = 6,
  label,
  maxHeight,
  renderMobile,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSortKey ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir);
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    // Copy first: sorting the prop array in place would mutate the caller's
    // react-query cache.
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, columns, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleSort = (col: Column<T>) => {
    if (!col.sortValue) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('asc');
    }
    setPage(1);
  };

  // `numeric` implies right-ranged; an explicit `align` always wins.
  const isRight = (col: Column<T>) => col.align === 'right' || (!!col.numeric && !col.align);

  const cellClass = (col: Column<T>) =>
    classNames(
      isRight(col) ? 'text-right' : col.align === 'center' ? 'text-center' : 'text-left',
      col.numeric && 'tabular-nums lining-nums',
      col.hideOnMobile && 'hidden md:table-cell',
      col.className,
    );

  /**
   * THE RUNNING HEADS, over an ink rule. Sticky is declared per CELL, not on the
   * row — `position: sticky` on a `<tr>` is still not honoured everywhere — and
   * it only bites when `maxHeight` has given the scroller a height. The opaque
   * fill is the page ground, because the ledger is set on the page.
   */
  const head = (
    <thead>
      <tr>
        {columns.map((col) => {
          const sortable = Boolean(col.sortValue);
          const active = sortKey === col.key;
          const right = isRight(col);
          return (
            <th
              key={col.key}
              scope="col"
              aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
              className={classNames(
                'sticky top-0 z-10 whitespace-nowrap border-b border-slate-900 bg-slate-50 px-3 pb-2 pt-1 align-bottom text-xs font-medium uppercase tracking-[0.18em] text-slate-500 first:pl-0 last:pr-0 dark:border-slate-100 dark:bg-slate-950 dark:text-slate-400',
                cellClass(col),
              )}
            >
              {sortable ? (
                <button
                  type="button"
                  onClick={() => toggleSort(col)}
                  className={classNames(
                    'inline-flex items-center gap-1 rounded-sm outline-none transition-colors duration-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-slate-100',
                    right && 'flex-row-reverse',
                  )}
                >
                  {col.header}
                  {/* The affordance is always present, never hover-revealed: a
                      sortable column nobody knows is sortable is not sortable. */}
                  {active ? (
                    sortDir === 'asc' ? (
                      <ArrowUp size={12} className="shrink-0" />
                    ) : (
                      <ArrowDown size={12} className="shrink-0" />
                    )
                  ) : (
                    <ChevronsUpDown size={12} className="shrink-0 text-slate-400" />
                  )}
                </button>
              ) : (
                col.header
              )}
            </th>
          );
        })}
      </tr>
    </thead>
  );

  const scroller = (body: ReactNode, extra?: { busy?: boolean; region?: boolean }) => (
    <div
      className="overflow-auto"
      style={maxHeight ? { maxHeight } : undefined}
      aria-busy={extra?.busy || undefined}
      // A scroll container has to be reachable without a mouse, and a region has
      // to be named to be announced.
      role={extra?.region ? 'region' : undefined}
      aria-label={extra?.region ? (label ?? 'Table') : undefined}
      tabIndex={extra?.region ? 0 : undefined}
    >
      <table className="w-full border-separate border-spacing-0 text-sm text-slate-700 dark:text-slate-300">
        {head}
        {body}
      </table>
    </div>
  );

  /**
   * Every non-row state keeps the ledger's frame — the running heads stay and
   * one cell spans the width. A page that swaps its whole table for a centred
   * icon the moment a filter matches nothing makes the operator re-find the
   * columns each time; this way only the body changes.
   */
  const frame = (body: ReactNode) =>
    scroller(
      <tbody>
        <tr>
          <td colSpan={columns.length}>{body}</td>
        </tr>
      </tbody>,
    );

  if (loading) {
    return (
      <>
        <span className="sr-only" role="status">
          Loading…
        </span>
        {scroller(
          <tbody>
            {Array.from({ length: skeletonRows }, (_, r) => (
              <tr key={r}>
                {columns.map((col, i) => (
                  <td
                    key={col.key}
                    className={classNames(
                      'px-3 py-3.5 align-middle first:pl-0 last:pr-0',
                      r > 0 && 'border-t border-slate-200 dark:border-slate-800',
                      cellClass(col),
                    )}
                  >
                    {/* Static, and stepped down the page so the block reads as
                        "not loaded yet" without a single frame of animation. */}
                    <Ghost
                      className="h-3"
                      style={{
                        width: GHOST_WIDTHS[(r + i) % GHOST_WIDTHS.length],
                        opacity: Math.max(0.25, 1 - r * 0.12),
                        marginLeft: isRight(col) ? 'auto' : undefined,
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>,
          { busy: true },
        )}
      </>
    );
  }

  if (error) {
    return frame(
      <div className="py-12">
        <span className="runhead text-red-600 dark:text-red-400">Could not load</span>
        <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
          {error}
        </p>
        {onRetry && (
          <button type="button" className="btn-secondary mt-5" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>,
    );
  }

  if (sorted.length === 0) {
    return frame(
      <div className="py-12">
        <span className="runhead">Nothing here</span>
        <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
          {emptyMessage}
        </p>
        {emptyHint && (
          <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {emptyHint}
          </p>
        )}
        {emptyAction && <div className="mt-5 flex flex-wrap gap-2">{emptyAction}</div>}
      </div>,
    );
  }

  const table = scroller(
    <tbody>
      {pageRows.map((row, r) => (
        <tr
          key={rowKey(row)}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          // Focusable, and Enter opens it. The row keeps its `row` role —
          // relabelling it as a button would break the table for a screen reader
          // to buy a keyboard affordance we can add without that.
          tabIndex={onRowClick ? 0 : undefined}
          onKeyDown={
            onRowClick
              ? (e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
                }
              : undefined
          }
          className={classNames(
            // 120ms, colour only: inside the frequency budget, and nothing
            // travels.
            'outline-none transition-colors duration-[var(--dur-press)]',
            onRowClick &&
              'cursor-pointer hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 dark:hover:bg-slate-800',
          )}
        >
          {columns.map((col) => (
            <td
              key={col.key}
              className={classNames(
                'px-3 py-3.5 align-middle first:pl-0 last:pr-0',
                // The rule falls BETWEEN rows only — never above the first,
                // which would double the header's ink rule, and never under the
                // last, which would leave a stroke hanging under the table.
                r > 0 && 'border-t border-slate-200 dark:border-slate-800',
                cellClass(col),
              )}
            >
              {col.render(row)}
            </td>
          ))}
        </tr>
      ))}
    </tbody>,
    { region: true },
  );

  /** The paging footer, closing the ledger the way the last row deliberately does not. */
  const pager = sorted.length > pageSize && (
    <nav
      className="rule mt-3 flex flex-col-reverse gap-3 pt-3 sm:flex-row sm:items-baseline sm:justify-between"
      aria-label="Pagination"
    >
      <p className="num text-xs text-slate-500 dark:text-slate-400">
        Page {safePage} of {totalPages} · {sorted.length.toLocaleString()} row
        {sorted.length === 1 ? '' : 's'}
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="btn-secondary !py-1.5"
          disabled={safePage <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn-secondary !py-1.5"
          disabled={safePage >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
      </div>
    </nav>
  );

  if (!renderMobile) {
    return (
      <>
        {table}
        {pager}
      </>
    );
  }

  return (
    <>
      {/* The stacked ledger: the same ink rule opens it, the same hairlines
          divide it. Only the row's own layout changes. */}
      <ul className="border-t border-slate-900 md:hidden dark:border-slate-100">
        {pageRows.map((row) => (
          <li
            key={rowKey(row)}
            className="border-t border-slate-200 first:border-t-0 dark:border-slate-800"
          >
            <div
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
                    }
                  : undefined
              }
              className={classNames(
                'py-3.5 outline-none',
                onRowClick &&
                  'cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
              )}
            >
              {renderMobile(row)}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">{table}</div>
      {pager}
    </>
  );
}

/**
 * Ghost bar widths. Deliberately uneven and cycled by (row + column) so the
 * placeholder reads as text of varying length rather than as a barcode.
 */
const GHOST_WIDTHS = ['72%', '46%', '84%', '58%', '38%', '66%'];
