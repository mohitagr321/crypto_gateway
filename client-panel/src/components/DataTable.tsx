import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';
import { LoadingPanel } from './Spinner';

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
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  /** Column key to sort by on first render. */
  defaultSortKey?: string;
  defaultSortDir?: 'asc' | 'desc';
}

/**
 * The table every list page renders.
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
  onRetry,
  onRowClick,
  defaultSortKey,
  defaultSortDir = 'desc',
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

  if (loading) return <LoadingPanel />;

  if (error) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        {onRetry && (
          <button type="button" className="btn-secondary" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 px-6 text-center">
        <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-slate-800">
          <Inbox size={20} />
        </span>
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {emptyLabel}
        </p>
        {emptyHint && (
          <p className="max-w-sm text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {emptyHint}
          </p>
        )}
      </div>
    );
  }

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          {/* Sticky header: a merchant scrolling a long payment list loses the
              column meaning immediately without it. */}
          <tr className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 text-left backdrop-blur dark:border-slate-800 dark:bg-slate-900/95">
            {columns.map((col) => {
              const sortable = Boolean(col.sortValue);
              const activeSort = sortKey === col.key;
              return (
                <th
                  key={col.key}
                  aria-sort={
                    activeSort ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                  className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 ${
                    col.hideOnMobile ? 'hidden md:table-cell' : ''
                  } ${col.className ?? ''}`}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className="group inline-flex items-center gap-1 transition hover:text-slate-800 dark:hover:text-slate-200"
                    >
                      {col.header}
                      {activeSort ? (
                        sortDir === 'asc' ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        )
                      ) : (
                        <ChevronsUpDown
                          size={12}
                          className="opacity-0 transition group-hover:opacity-60"
                        />
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
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`transition-colors ${
                onRowClick
                  ? 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50'
                  : ''
              }`}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-4 py-3 align-middle text-slate-700 dark:text-slate-300 ${
                    col.hideOnMobile ? 'hidden md:table-cell' : ''
                  } ${col.className ?? ''}`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
