import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { classNames } from '@/lib/format';

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
   *
   * PASS `dvh`, NEVER `vh`. On mobile Safari `vh` measures the viewport WITHOUT
   * the collapsing toolbar, so a `70vh` cap is taller than 70% of what the
   * operator can actually see. It never bites in practice on this component —
   * the mobile branch renders an unbounded list and the table is `hidden
   * md:block` — but the unit is wrong and the next person to copy it will not
   * know that.
   */
  maxHeight?: string;
  /**
   * Stacked layout for narrow screens. Supplying it is worth it wherever the row
   * has a natural mobile shape; a row with none now gets a generic stacked
   * fallback rather than a horizontal scrollbar. See `defaultMobileRow`.
   */
  renderMobile?: (row: T) => ReactNode;
  /**
   * Freeze the first column while the rest scrolls sideways. Worth it when
   * column one is the identity of the row (a transaction id, a merchant name)
   * and worthless otherwise, so it is opt-in — it costs an opaque fill.
   */
  stickyFirstColumn?: boolean;
}

/**
 * The table every list page renders — set as a LEDGER.
 *
 * Hairline rules between rows, a running head over the ledger's own rule, money
 * ranged right on tabular figures, and no enclosure of its own: the table ranges
 * to the edges of whatever surface it is placed on, which on a converted page is
 * a `<Section flush>`. A financial table is the one place a hairline beats a
 * border outright — rows are separated by a stroke, and the ~24px of padding a
 * second box would charge on all four sides is bought back as rows of data.
 * Zebra striping is what you reach for when the row rule is missing; with the
 * rule there it is just noise that also breaks selection highlighting.
 *
 * IT IS NOW THE `.ledger` BLOCK FROM index.css rather than a hand-rolled stack
 * of utilities. That is the whole point of this pass: the merchant panel renders
 * the same ledger from the same class names, so the two cannot drift, and the
 * mechanics that are genuinely hard — the opaque sticky ground, the CSS-only
 * scroll shadows, the frozen column's fill, the `:where()` wrappers that keep
 * page utilities winning over structural selectors — live in one place instead
 * of being approximated here.
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
  stickyFirstColumn = false,
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

  const cellClass = (col: Column<T>, index: number) =>
    classNames(
      isRight(col) ? 'text-right' : col.align === 'center' ? 'text-center' : '',
      col.numeric && 'num lining-nums',
      col.hideOnMobile && 'hidden md:table-cell',
      stickyFirstColumn && index === 0 && 'ledger-freeze',
      col.className,
    );

  /**
   * THE RUNNING HEADS. Sticky is declared per CELL by `.ledger`, not on the row —
   * `position: sticky` on a `<tr>` is still not honoured everywhere — and it only
   * bites once `maxHeight` has given the scroller a height.
   *
   * NOTHING HERE SETS `whitespace-nowrap` ANY MORE, and that single removal is
   * the highest-leverage table fix in this panel. Uppercase plus wide tracking
   * plus nowrap is what actually sets a ledger's minimum width, and this console
   * had the widest tracking (0.18em) on the panel with the most columns — which
   * is why the operator tables dragged sideways on a phone even where their data
   * would have fit. `.ledger` wraps the heads below `sm` and puts them back on
   * one line above it, where there is room.
   */
  const head = (
    <thead>
      <tr>
        {columns.map((col, i) => {
          const sortable = Boolean(col.sortValue);
          const active = sortKey === col.key;
          const right = isRight(col);
          return (
            <th
              key={col.key}
              scope="col"
              aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
              className={cellClass(col, i)}
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

  /**
   * Every non-row state keeps the ledger's frame — the running heads stay and
   * one cell spans the width. A page that swaps its whole table for a centred
   * icon the moment a filter matches nothing makes the operator re-find the
   * columns each time; this way only the body changes.
   *
   * ON A PHONE THE FRAME IS DROPPED ENTIRELY, and that is a fix rather than a
   * simplification. These states used to render the full desktop table before
   * the `renderMobile` branch at the bottom of this file was ever reached, so
   * every list page in the console dragged sideways WHILE LOADING and WHEN
   * EMPTY — which is first paint on every single visit, the one moment the
   * layout is most likely to be judged. Column headings are meaningless next to
   * "nothing here" anyway.
   */
  const frame = (body: ReactNode) => (
    <>
      <div className="px-1 py-8 md:hidden">{body}</div>
      <div className="ledger-scroll hidden md:block">
        <table className="ledger">
          {head}
          <tbody>
            <tr>
              <td colSpan={columns.length} className="py-0">
                {body}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );

  if (loading) {
    return (
      <>
        <span className="sr-only" role="status">
          Loading…
        </span>
        {/* The stacked placeholder, for the same reason the frame drops on a
            phone: a skeleton that overflows the viewport is a worse first
            impression than the real table it stands in for. */}
        <ul className="md:hidden" aria-busy="true">
          {Array.from({ length: Math.min(skeletonRows, 5) }, (_, r) => (
            <li
              key={r}
              className="border-t border-[var(--line-soft)] py-3.5 first:border-t-0"
              style={{ opacity: Math.max(0.3, 1 - r * 0.15) }}
            >
              <span aria-hidden className="ghost h-3.5 w-1/2" />
              <span aria-hidden className="ghost mt-2 h-3 w-3/4" />
            </li>
          ))}
        </ul>
        <div className="ledger-scroll hidden md:block" aria-busy="true">
          <table className="ledger">
            {head}
            <tbody>
              {Array.from({ length: skeletonRows }, (_, r) => (
                <tr key={r} className="ledger-row">
                  {columns.map((col, i) => (
                    <td key={col.key} className={cellClass(col, i)}>
                      {/* Static, and stepped down the page so the block reads as
                          "not loaded yet" without a single frame of animation —
                          the frequency boundary bans loops on a console route. */}
                      <span
                        aria-hidden
                        className="ghost h-3"
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
            </tbody>
          </table>
        </div>
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

  const table = (
    <div
      className="ledger-scroll"
      style={maxHeight ? { maxHeight } : undefined}
      // A scroll container has to be reachable without a mouse, and a region has
      // to be named to be announced.
      role="region"
      aria-label={label ?? 'Table'}
      tabIndex={0}
    >
      <table className="ledger">
        {head}
        <tbody>
          {pageRows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              // Focusable, and Enter opens it. The row keeps its `row` role —
              // relabelling it as a button would break the table for a screen
              // reader to buy a keyboard affordance we can add without that.
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
                    }
                  : undefined
              }
              className={classNames(
                'ledger-row outline-none',
                onRowClick &&
                  'ledger-row-click focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
              )}
            >
              {columns.map((col, i) => (
                <td key={col.key} className={cellClass(col, i)}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  /** The paging footer, closing the ledger the way the last row deliberately does not. */
  const pager = sorted.length > pageSize && (
    <nav
      className="rule mt-3 flex flex-col-reverse gap-3 pt-3 sm:flex-row sm:items-center sm:justify-between"
      aria-label="Pagination"
    >
      <p className="num text-xs text-slate-500 dark:text-slate-400">
        Page {safePage} of {totalPages} · {sorted.length.toLocaleString()} row
        {sorted.length === 1 ? '' : 's'}
      </p>
      <div className="flex shrink-0 gap-2">
        {/* `.btn` carries the 44px floor itself now, so the `!py-1.5` override
            these two used to wear no longer buys anything except a control an
            operator misses with a thumb. */}
        <button
          type="button"
          className="btn-secondary"
          disabled={safePage <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={safePage >= totalPages}
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
        >
          Next
        </button>
      </div>
    </nav>
  );

  /**
   * THE DEFAULT STACKED ROW.
   *
   * Four pages in this console called DataTable with no `renderMobile`, and
   * every one of them handed a phone a seven-column table to drag sideways.
   * Making the prop optional was the mistake: the fallback should never have
   * been "the desktop table, but worse".
   *
   * So a row with no bespoke mobile layout gets a generic one — the first column
   * as the row's title, every other visible column as a label/value pair. It is
   * not as good as a hand-built layout, which is why `renderMobile` still exists
   * and is still worth writing; it is enormously better than a horizontal
   * scrollbar, which is the bar it has to clear.
   *
   * `hideOnMobile` columns stay hidden here too. A column the author judged
   * unimportant enough to drop on a narrow TABLE is not one to promote to its
   * own row in a narrow LIST.
   */
  const defaultMobileRow = (row: T) => {
    const visible = columns.filter((c) => !c.hideOnMobile);
    const [lead, ...rest] = visible;
    return (
      <div className="space-y-2">
        {lead && (
          <div className="text-[13.5px] font-medium text-slate-900 dark:text-slate-100">
            {lead.render(row)}
          </div>
        )}
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5">
          {rest.map((col) => (
            <Fragment key={col.key}>
              <dt className="truncate text-[11px] uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                {col.header}
              </dt>
              {/* `break-words`, never `truncate`: half of what this console puts
                  in a cell is an address, a hash or an amount, and every one of
                  those is read wrong rather than noticed when it is cut. */}
              <dd
                className={classNames(
                  'min-w-0 break-words text-right text-[13px] text-slate-700 dark:text-slate-300',
                  col.numeric && 'num',
                )}
              >
                {col.render(row)}
              </dd>
            </Fragment>
          ))}
        </dl>
      </div>
    );
  };

  const mobileRow = renderMobile ?? defaultMobileRow;

  return (
    <>
      {/* The stacked ledger: the same hairlines divide it. Only the row's own
          layout changes. */}
      <ul className="md:hidden">
        {pageRows.map((row) => (
          <li key={rowKey(row)} className="border-t border-[var(--line-soft)] first:border-t-0">
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
              {mobileRow(row)}
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
