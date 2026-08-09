import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { Fragment, useState } from 'react';
import Badge from '@/components/Badge';
import PageHeader from '@/components/PageHeader';
import Spinner from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import { apiErrorMessage, listWebhookLogs } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import type { WebhookLog } from '@/types';

export default function WebhookLogs() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['webhook-logs', onlyFailed],
    queryFn: () => listWebhookLogs(onlyFailed ? { success: false } : undefined),
  });

  const logs = data?.data ?? [];

  const renderPayload = (payload: WebhookLog['payload']) => {
    if (payload == null) return '—';
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    return text;
  };

  return (
    <>
      <PageHeader
        title="Webhook Logs"
        subtitle="Delivery attempts to client webhook endpoints"
        actions={
          <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300"
              checked={onlyFailed}
              onChange={(e) => setOnlyFailed(e.target.checked)}
            />
            Failures only
          </label>
        }
      />

      {isLoading ? (
        <Spinner label="Loading webhook logs…" />
      ) : isError ? (
        <ErrorState message={apiErrorMessage(error)} onRetry={() => refetch()} />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:bg-gray-800/50 dark:text-gray-400">
                  <th className="w-8 px-4 py-3" />
                  <th className="px-4 py-3 font-medium">Event</th>
                  <th className="px-4 py-3 font-medium">Client</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Attempt</th>
                  <th className="px-4 py-3 font-medium">Next retry</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                      No webhook attempts recorded.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => {
                    const isOpen = expanded === log.id;
                    return (
                      <Fragment key={log.id}>
                        <tr
                          className="cursor-pointer transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
                          onClick={() => setExpanded(isOpen ? null : log.id)}
                        >
                          <td className="px-4 py-3 text-gray-400">
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="px-4 py-3">
                            <code className="text-xs">{log.event}</code>
                          </td>
                          <td className="px-4 py-3">{log.clientName ?? log.clientId}</td>
                          <td className="px-4 py-3">
                            <span className="inline-flex items-center gap-2">
                              {log.success ? (
                                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                              ) : (
                                <XCircle className="h-4 w-4 text-red-500" />
                              )}
                              <Badge tone={log.success ? 'green' : 'red'}>
                                {log.statusCode ?? (log.success ? 'ok' : 'error')}
                              </Badge>
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {log.attempt}
                            {log.maxAttempts ? ` / ${log.maxAttempts}` : ''}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            {log.success ? '—' : log.nextRetryAt ? relativeTime(log.nextRetryAt) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{formatDate(log.createdAt)}</td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-gray-50/70 dark:bg-gray-800/30">
                            <td colSpan={7} className="px-4 py-4">
                              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase text-gray-500">Endpoint</p>
                                  <code className="block overflow-x-auto rounded-lg bg-white px-3 py-2 text-xs dark:bg-gray-900">
                                    {log.url}
                                  </code>
                                  {log.response && (
                                    <>
                                      <p className="mb-1 mt-3 text-xs font-medium uppercase text-gray-500">
                                        Response
                                      </p>
                                      <pre className="max-h-40 overflow-auto rounded-lg bg-white px-3 py-2 text-xs dark:bg-gray-900">
                                        {log.response}
                                      </pre>
                                    </>
                                  )}
                                </div>
                                <div>
                                  <p className="mb-1 text-xs font-medium uppercase text-gray-500">Payload</p>
                                  <pre className="max-h-56 overflow-auto rounded-lg bg-white px-3 py-2 text-xs dark:bg-gray-900">
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
        </div>
      )}
    </>
  );
}
