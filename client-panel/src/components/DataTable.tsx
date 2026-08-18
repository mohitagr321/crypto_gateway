import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  className?: string;
  /** Hide on small screens. */
  hideOnMobile?: boolean;
  /**
   * Return the value to sort this column by. Supplying it makes the header
   * clickable; omitting it leaves the column unsortable, which is correct for
   * an actions column or a rendered badge with no natural order.
   */
  sortValue?: (row: T) => string | number;
  /**
   * MONEY, AND ANYTHING ELSE READ AS A QUANTITY. Ranges the column right — so
   * the decimal points stack and the eye can compare magnitudes down the
   * column instead of reading every figure — and sets tabular lining numerals
   * on the cell and its header together.
   *
   * A money column that is not marked `numeric` is a bug you can see from
   * across the room: 1,240.00 and 9.50 start at the same left edge and look
   * the same size.
   */
  numeric?: boolean;
  /**
   * Ranging override for columns that are not quantities — an actions column
   * usually wants 'right'. `numeric` already implies 'right'.
   */
  align?: 'left' | 'right';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  emptyLabel?: string;
  /** Shown under the empty label — say what to do, not just that there is nothing. */
  emptyHint?: ReactNode;
  /** A control that resolves the empty state: "Create a payment", "Clear filters". */
  emptyAction?: ReactNode;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  /** Column key to sort by on first render. */
  defaultSortKey?: string;
  defaultSortDir?: 'asc' | 'desc';
  /** Ghost rows drawn while loading. Match the page size you actually render. */
  skeletonRows?: number;
  /**
   * Stacked fallback for narrow screens. When supplied, the table is replaced
   * below `md` by a ruled list of these, which beats making a merchant drag a
   * six-column ledger sideways on a phone. Return the row's own layout; the
   * rule and the hit area are drawn for you.
   */
  renderMobile?: (row: T) => ReactNode;
  /**
   * Freeze the first column while the rest scrolls sideways. Worth it when
   * column one is the identity of the row (order id, payout id) and worthless
   * otherwise, so it is opt-in.
   */
  stickyFirstColumn?: boolean;
  /** Names the scroll region for screen readers and for the keyboard scroller. */
  label?: string;
  /**
   * Cap the table's height (e.g. '70vh') and let it scroll inside that box.
   *
   * THIS IS THE ONLY WAY THE STICKY HEADER ACTUALLY STICKS, and it is worth
   * knowing why before you copy a `sticky` class around. A box that scrolls
   * sideways is a vertical scroll container too — the spec coerces overflow-y
   * to `auto`/`hidden` the moment overflow-x is `auto` — so a sticky header
   * inside it resolves against THAT box rather than the page. With no height
   * limit the box never scrolls, and the header sticks to nothing. That is
   * exactly what shipped before: the header was marked sticky and had never
   * stuck once.
   *
   * Give it a height and the box becomes the scroller, the header pins to its
   * top, and the merchant keeps the column meaning through a thousand rows.
   * The cost is a nested scroll region, so it is opt-in per page: worth it on
   * a long list (payments, payouts), pointless on a five-row summary.
   */
  maxHeight?: string;
}

/**
 * The table every list page renders — set as a LEDGER.
 *
 * Hairline rules between rows, a running head over an ink rule for the header,
 * money ranged right on tabular figures, and no enclosure at all: the table is
 * placed on the page rather than inside a card. See the LEDGER block in
 * index.css for the ground/sticky mechanics.
 *
 * Sorting is CLIENT-SIDE and only ever reorders the rows it was handed. On a
 * paginated page that means it sorts the current page, not the whole result
 * set — the alternative would be silently telling a merchant they are looking
 * at "the largest payments" when they are looking at the largest of twenty.
 * Pages that need true ordering must ask the API for it.
 */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  emptyLabel = 'No records found.',
  emptyHint,
  emptyAction,
  onRetry,
  onRowClick,
  defaultSortKey,
  defaultSortDir = 'desc',
  skeletonRows = 6,
  renderMobile,
  stickyFirstColumn = false,
  label,
  maxHeight,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultSortDir);

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey && c.sortValue);
    if (!col?.sortValue) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    // Copy first: sorting the prop array in place would mutate the caller's
    // query cache.
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, columns, sortKey, sortDir]);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // `numeric` implies right-ranged; an explicit `align` always wins.
  const isRight = (col: Column<T>) => col.align === 'right' || (!!col.numeric && !col.align);

  const cellClass = (col: Column<T>, index: number) => {
    return [
      isRight(col) ? 'text-right' : '',
      col.numeric ? 'num lining-nums' : '',
      col.hideOnMobile ? 'hidden md:table-cell' : '',
      stickyFirstColumn && index === 0 ? 'ledger-freeze' : '',
      col.className ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  };

  const head = (
    <thead>
      <tr>
        {columns.map((col, i) => {
          const sortable = Boolean(col.sortValue);
          const activeSort = sortKey === col.key;
          const right = isRight(col);
          return (
            <th
              key={col.key}
              scope="col"
              aria-sort={
                activeSort ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
              }
              className={cellClass(col, i)}
            >
              {sortable ? (
                <button
                  type="button"
                  onClick={() => toggleSort(col.key)}
                  className={`inline-flex items-center gap-1 rounded-sm outline-none transition-colors duration-100 hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-slate-100 ${
                    right ? 'flex-row-reverse' : ''
                  }`}
                >
                  {col.header}
                  {/* The affordance is always present, not hover-revealed: a
                      sortable column nobody knows is sortable is not sortable. */}
                  {activeSort ? (
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
   * Every non-row state keeps the ledger's frame — the running heads stay, and
   * one cell spans the width. A page that swaps its whole table for a centred
   * icon the moment a filter matches nothing makes the merchant re-find the
   * columns each time; this way only the body changes.
   *
   * ON A PHONE THE FRAME IS DROPPED ENTIRELY, and that is a fix rather than a
   * simplification. These states used to render the full desktop table before
   * the `renderMobile` branch below was ever reached, so every list page
   * dragged sideways WHILE LOADING and WHEN EMPTY — which is first paint on
   * every single visit, the one moment the layout is most likely to be judged.
   * Column headings are meaningless next to "nothing here" anyway.
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
                      {/* Static, and stepped down the page so the block reads
                          as "not loaded yet" without a single frame of
                          animation — the frequency boundary bans loops here. */}
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

  if (rows.length === 0) {
    return frame(
      <div className="py-12">
        <span className="runhead">Nothing here</span>
        <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
          {emptyLabel}
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
      // A scroll container has to be reachable without a mouse, and a region
      // has to be named to be announced.
      role="region"
      aria-label={label ?? 'Table'}
      tabIndex={0}
    >
      <table className="ledger">
        {head}
        <tbody>
          {sorted.map((row) => (
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
                      if (e.key === 'Enter' && e.target === e.currentTarget) {
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={`ledger-row outline-none ${
                onRowClick
                  ? 'ledger-row-click focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500'
                  : ''
              }`}
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

  /**
   * THE DEFAULT STACKED ROW.
   *
   * Eight pages across the two panels called DataTable with no `renderMobile`,
   * and every one of them handed a phone a six-column table to drag sideways.
   * Making the prop optional was the mistake: the fallback should never have
   * been "the desktop table, but worse".
   *
   * So a row with no bespoke mobile layout gets a generic one — the first
   * column as the row's title, every other visible column as a label/value
   * pair. It is not as good as a hand-built layout, which is why `renderMobile`
   * still exists and is still worth writing; it is enormously better than a
   * horizontal scrollbar, which is the bar it has to clear.
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
              <dd
                className={`min-w-0 break-words text-right text-[13px] text-slate-700 dark:text-slate-300 ${
                  col.numeric ? 'num' : ''
                }`}
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
      {/* The stacked ledger: the same rule opens it, the same hairlines divide
          it. Only the row's own layout changes. */}
      <ul className="md:hidden">
        {sorted.map((row) => (
          <li
            key={rowKey(row)}
            className="border-t border-[var(--line-soft)] first:border-t-0"
          >
            <div
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' && e.target === e.currentTarget) {
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
              className={`py-3.5 outline-none ${
                onRowClick
                  ? 'cursor-pointer focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500'
                  : ''
              }`}
            >
              {mobileRow(row)}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">{table}</div>
    </>
  );
}

/**
 * Ghost bar widths. Deliberately uneven and cycled by (row + column) so the
 * placeholder reads as text of varying length rather than a barcode.
 */
const GHOST_WIDTHS = ['72%', '46%', '84%', '58%', '38%', '66%'];
