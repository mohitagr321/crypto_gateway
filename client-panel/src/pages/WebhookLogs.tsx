import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Info, RefreshCw } from 'lucide-react';
import { getWebhookLogs } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { formatDate, shortHash } from '@/lib/format';
import type { WebhookLog } from '@/types';
import PageHeader from '@/components/PageHeader';
import { WebhookStatusBadge } from '@/components/Badge';
import { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import CopyButton from '@/components/CopyButton';

function prettyJson(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function LogRow({ log }: { log: WebhookLog }) {
  const [open, setOpen] = useState(false);
  const body = prettyJson(log.requestBody);
  const response = prettyJson(log.responseBody);

  return (
    <div className="border-b border-slate-100 last:border-0 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        {open ? (
          <ChevronDown size={16} className="shrink-0 text-slate-400" />
        ) : (
          <ChevronRight size={16} className="shrink-0 text-slate-400" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-700 dark:text-slate-200">
              {log.event}
            </span>
            <WebhookStatusBadge status={log.status} />
            {log.httpStatus !== null && (
              <span className="font-mono text-xs text-slate-400">
                HTTP {log.httpStatus}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-400">{log.url}</p>
        </div>
        <div className="hidden shrink-0 text-right text-xs text-slate-400 sm:block">
          <p>attempt {log.attempt}/{log.maxAttempts}</p>
          <p>{formatDate(log.createdAt)}</p>
        </div>
      </button>

      {open && (
        <div className="space-y-3 bg-slate-50 px-4 pb-4 pt-1 dark:bg-slate-800/40">
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {log.paymentId && (
              <div>
                <p className="text-slate-400">Payment</p>
                <p className="font-mono text-slate-600 dark:text-slate-300">
                  {shortHash(log.paymentId, 8, 4)}
                </p>
              </div>
            )}
            <div>
              <p className="text-slate-400">Attempt</p>
              <p className="text-slate-600 dark:text-slate-300">
                {log.attempt} / {log.maxAttempts}
              </p>
            </div>
            {log.nextRetryAt && (
              <div>
                <p className="text-slate-400">Next retry</p>
                <p className="text-slate-600 dark:text-slate-300">
                  {formatDate(log.nextRetryAt)}
                </p>
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium text-slate-500">Request body</p>
              <CopyButton value={body} label="Copy" />
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100">
              <code>{body || '—'}</code>
            </pre>
          </div>

          {response && (
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">Response</p>
              <pre className="max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100">
                <code>{response}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function WebhookLogs() {
  const query = useQuery({
    queryKey: ['webhook-logs'],
    queryFn: getWebhookLogs,
  });

  const logs = query.data ?? [];

  return (
    <>
      <PageHeader
        title="Webhook Logs"
        description="Delivery attempts for your configured webhook endpoint."
        actions={
          <button
            className="btn-secondary"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              size={16}
              className={query.isFetching ? 'animate-spin' : ''}
            />
            Refresh
          </button>
        }
      />

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
        <Info size={16} className="mt-0.5 shrink-0 text-brand-600" />
        <span>
          Failed deliveries are retried automatically with exponential backoff
          (up to the configured max attempts). Expand any row to inspect the
          exact payload we sent.
        </span>
      </div>

      <div className="card">
        {query.isLoading ? (
          <LoadingPanel />
        ) : query.isError ? (
          <ErrorState
            message={errorMessage(query.error)}
            onRetry={() => query.refetch()}
          />
        ) : logs.length === 0 ? (
          <div className="py-16 text-center text-sm text-slate-400">
            No webhook deliveries yet.
          </div>
        ) : (
          logs.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </>
  );
}
