import { ChevronDown, ChevronUp, ChevronsUpDown, Inbox } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { classNames } from '@/lib/format';
import Spinner from './Spinner';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** How to render the cell. */
  render: (row: T) => ReactNode;
  /** Value used for client-side sorting. Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  className?: string;
  align?: 'left' | 'right' | 'center';
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  emptyMessage?: string;
  pageSize?: number;
  onRowClick?: (row: T) => void;
}

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage = 'No records found.',
  pageSize = 10,
  onRowClick,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
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

  const alignClass = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-800/50 dark:text-gray-400">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={classNames('whitespace-nowrap px-4 py-3 font-medium', alignClass(col.align), col.className)}
                >
                  {col.sortValue ? (
                    <button
                      onClick={() => toggleSort(col)}
                      className="inline-flex items-center gap-1 hover:text-gray-800 dark:hover:text-gray-200"
                    >
                      {col.header}
                      {sortKey === col.key ? (
                        sortDir === 'asc' ? (
                          <ChevronUp className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronDown className="h-3.5 w-3.5" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="px-4">
                  <Spinner label="Loading…" />
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-red-600 dark:text-red-400">
                  {error}
                </td>
              </tr>
            ) : pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-gray-400">
                  <Inbox className="mx-auto mb-2 h-8 w-8 opacity-50" />
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={classNames(
                    'transition',
                    onRowClick && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50'
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={classNames('whitespace-nowrap px-4 py-3', alignClass(col.align), col.className)}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!loading && !error && sorted.length > pageSize && (
        <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-sm dark:border-gray-800">
          <span className="text-gray-500 dark:text-gray-400">
            Page {safePage} of {totalPages} · {sorted.length} rows
          </span>
          <div className="flex gap-2">
            <button
              className="btn-secondary !py-1"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              className="btn-secondary !py-1"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
