import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import Badge from '@/components/Badge';
import ErrorState from '@/components/ErrorState';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
import { apiErrorMessage, listWebhookLogs } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import type { WebhookLog } from '@/types';

/**
 * DELIVERY ATTEMPTS, set as a ledger with rows that open.
 *
 * The expansion is the point of this screen — an operator is here because a
 * merchant said "we never got the webhook", and the answer is in the endpoint,
 * the response and the payload. So the row opens in place under its own hairline
 * rather than pushing them into a modal that loses the row they were reading.
 *
 * It is a hand-rolled table rather than DataTable because DataTable has no
 * concept of a row that expands, and giving it one to serve a single page would
 * cost every other ledger a prop. Everything visible is the same ledger
 * treatment: running heads over an ink rule, hairlines between rows, ranged to
 * the ends of the page.
 */
export default function WebhookLogs() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['webhook-logs', onlyFailed],
    queryFn: () => listWebhookLogs(onlyFailed ? { success: false } : undefined),
  });

  const logs = data?.data ?? [];

  const renderPayload = (payload: WebhookLog['payload']) => {
    if (payload == null) return '—';
    return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  };

  return (
    <>
      <PageHeader
        eyebrow="Monitoring"
        title="Webhook logs"
        subtitle="Every delivery attempt to a merchant's endpoint, with the response it came back with."
        actions={
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-400 accent-brand-600 dark:border-slate-600"
              checked={onlyFailed}
              onChange={(e) => setOnlyFailed(e.target.checked)}
            />
            Failures only
          </label>
        }
        meta={
          isLoading
            ? undefined
            : `${logs.length.toLocaleString()} attempt${logs.length === 1 ? '' : 's'}${
                onlyFailed ? ' · failures only' : ''
              }${isFetching ? ' · updating' : ''}`
        }
      />

      {isLoading ? (
        <Spinner label="Loading webhook logs…" />
      ) : isError ? (
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      ) : (
        <>
          <div className="overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm text-slate-700 dark:text-slate-300">
              <thead>
                <tr>
                  {/* The disclosure column has no name; a running head over an
                      empty 2rem column would be labelling a chevron. */}
                  <Th className="w-8" />
                  <Th>Event</Th>
                  <Th>Client</Th>
                  <Th>Result</Th>
                  <Th className="text-right">Attempt</Th>
                  <Th className="hidden md:table-cell">Next retry</Th>
                  <Th className="hidden md:table-cell">Time</Th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-12">
                      <span className="runhead">Nothing here</span>
                      <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
                        {onlyFailed
                          ? 'No failed delivery attempts. Every webhook the gateway has sent was accepted.'
                          : 'No webhook attempts recorded.'}
                      </p>
                      {onlyFailed && (
                        <button
                          type="button"
                          className="btn-secondary mt-5"
                          onClick={() => setOnlyFailed(false)}
                        >
                          Show every attempt
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  logs.map((log, i) => {
                    const isOpen = expanded === log.id;
                    const ruled = i > 0 ? 'border-t border-slate-200 dark:border-slate-800' : '';
                    return (
                      <Fragment key={log.id}>
                        <tr
                          className="cursor-pointer outline-none transition-colors duration-[var(--dur-press)] hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 dark:hover:bg-slate-800"
                          tabIndex={0}
                          aria-expanded={isOpen}
                          onClick={() => setExpanded(isOpen ? null : log.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && e.target === e.currentTarget) {
                              setExpanded(isOpen ? null : log.id);
                            }
                          }}
                        >
                          <Td className={`${ruled} text-slate-400`}>
                            {isOpen ? (
                              <ChevronDown className="h-4 w-4" aria-hidden />
                            ) : (
                              <ChevronRight className="h-4 w-4" aria-hidden />
                            )}
                            <span className="sr-only">
                              {isOpen ? 'Hide' : 'Show'} delivery detail
                            </span>
                          </Td>
                          <Td className={ruled}>
                            <code className="code">{log.event}</code>
                          </Td>
                          <Td className={`${ruled} font-medium text-slate-900 dark:text-slate-100`}>
                            {log.clientName ?? log.clientId}
                          </Td>
                          <Td className={ruled}>
                            {/* The HTTP status is the fact; the word beside it is
                                what makes the colour redundant rather than
                                load-bearing. */}
                            <Badge tone={log.success ? 'settled' : 'failed'}>
                              {log.success ? 'ok' : 'failed'}
                              {log.statusCode != null && ` · ${log.statusCode}`}
                            </Badge>
                          </Td>
                          <Td className={`${ruled} text-right tabular-nums lining-nums`}>
                            {log.attempt}
                            {log.maxAttempts ? ` / ${log.maxAttempts}` : ''}
                          </Td>
                          <Td className={`${ruled} hidden md:table-cell`}>
                            {log.success ? (
                              <span className="text-slate-500 dark:text-slate-400">
                                not needed
                              </span>
                            ) : log.nextRetryAt ? (
                              <span className="text-amber-600 dark:text-amber-400">
                                {relativeTime(log.nextRetryAt)}
                              </span>
                            ) : (
                              <span className="text-slate-500 dark:text-slate-400">
                                no retry left
                              </span>
                            )}
                          </Td>
                          <Td
                            className={`${ruled} hidden whitespace-nowrap text-slate-500 md:table-cell dark:text-slate-400`}
                          >
                            {formatDate(log.createdAt)}
                          </Td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={7} className="border-t border-slate-200 py-4 dark:border-slate-800">
                              <div className="grid grid-cols-1 gap-x-10 gap-y-6 lg:grid-cols-2">
                                <div className="min-w-0">
                                  <span className="runhead">Endpoint</span>
                                  <code className="mt-1.5 block overflow-x-auto rounded bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                                    {log.url}
                                  </code>
                                  {log.response && (
                                    <>
                                      <span className="runhead mt-4 block">Response</span>
                                      <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                                        {log.response}
                                      </pre>
                                    </>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <span className="runhead">Payload</span>
                                  <pre className="mt-1.5 max-h-56 overflow-auto rounded bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                                    {renderPayload(log.payload)}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="measure-wide rule mt-4 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            The failures-only switch is asked of the server. Open a row to see the
            endpoint, the payload the gateway sent and whatever came back.
          </p>
        </>
      )}
    </>
  );
}

/** A running head in this page's hand-rolled ledger. */
function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`whitespace-nowrap border-b border-slate-900 px-3 pb-2 pt-1 text-left align-bottom text-xs font-medium uppercase tracking-[0.18em] text-slate-500 first:pl-0 last:pr-0 dark:border-slate-100 dark:text-slate-400 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <td className={`px-3 py-3.5 align-middle first:pl-0 last:pr-0 ${className}`}>{children}</td>
  );
}
