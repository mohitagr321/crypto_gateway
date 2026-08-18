import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import Badge from '@/components/Badge';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
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
 * WHY IT IS NO LONGER A `<table>`.
 *
 * It was a hand-rolled seven-column table, and it was the worst offender in the
 * console on a phone: every running head carried `whitespace-nowrap` at 0.18em
 * tracking, which is what actually set the table's minimum width, and only two
 * of the seven columns dropped below `md`. So the one screen an operator opens
 * away from their desk — because something is failing right now — was the one
 * screen that had to be dragged sideways to read. There was no mobile form of it
 * at all, because a table with an expanding row cannot have one: a disclosure
 * inside a cell fights the table for width at every breakpoint.
 *
 * It is now the same disclosure list the merchant panel's webhook log is built
 * from — `Section` for the surface and the running head, hairlines between rows,
 * and the same ruled loading, error and empty states `DataTable` renders — so
 * the two panels' delivery logs are one object even though neither is a table.
 * An operator with both windows open should not have to learn this screen twice.
 *
 * EVERY FACT IN THE ROW IS REACHABLE AT 360px. The attempt counter, the next
 * retry and the sent time fall under the endpoint on a narrow viewport and range
 * right on a wide one; nothing is hidden, because "how many tries in are we" and
 * "when does it try again" are the two questions this page exists to answer.
 *
 * MOTION: exactly one thing moves — the disclosure chevron rotates, keyed to the
 * open state, which is a value CHANGE rather than a mount. Transform only, at
 * `--dur-pop`.
 */

/** Uneven, cycled ghost widths so the placeholder reads as text, not a barcode. */
const GHOST_WIDTHS = ['62%', '38%', '74%', '46%', '30%', '55%'];

function renderPayload(payload: WebhookLog['payload']): string {
  if (payload == null) return '—';
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

export default function WebhookLogs() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['webhook-logs', onlyFailed],
    queryFn: () => listWebhookLogs(onlyFailed ? { success: false } : undefined),
  });

  const logs = data?.data ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Monitoring"
        title="Webhook logs"
        description="Every delivery attempt to a merchant's endpoint, with the response it came back with."
        actions={
          // 44px on the whole label, not just the box. A 16px checkbox is a
          // 16px target however much text sits beside it unless the label is
          // told to be a control, and this one filters the entire page.
          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg px-1 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              className="h-5 w-5 rounded border-slate-400 accent-brand-600 dark:border-slate-600"
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

      {/* `flush`, for the same reason a ledger gets it: the rows draw their own
          hairlines edge to edge, and body padding would inset them from the
          rules that divide them. The `aside` is the second running head — what
          the right-hand column of each row holds, named once at the top and
          hidden below `sm`, where that column is not there to be named. */}
      <Section
        flush
        title="Delivery"
        aside={<span className="runhead hidden sm:block">Attempt · Sent</span>}
      >
        {isLoading ? (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading…
            </span>
            {GHOST_WIDTHS.map((w, i) => (
              <div key={w} className="border-t border-[var(--line-soft)] py-4 first:border-t-0">
                {/* Static, stepped down the page: the frequency boundary bans a
                    loop on a console route, so shape and opacity do the work a
                    shimmer used to. */}
                <span
                  aria-hidden
                  className="ghost h-3"
                  style={{ width: w, opacity: Math.max(0.25, 1 - i * 0.12) }}
                />
              </div>
            ))}
          </div>
        ) : isError ? (
          /* The same markup the ledger's error state uses, deliberately: an
             operator who sees a request fail inside a table and then again here
             should be reading the same thing twice, not two dialects of "it
             broke". */
          <div className="py-12" role="alert">
            <span className="runhead text-red-600 dark:text-red-400">Could not load</span>
            <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
              {apiErrorMessage(error)}
            </p>
            <button type="button" className="btn-secondary mt-5" onClick={() => refetch()}>
              Retry
            </button>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-12">
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
          </div>
        ) : (
          <ul>
            {logs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                open={expanded === log.id}
                onToggle={() => setExpanded(expanded === log.id ? null : log.id)}
              />
            ))}
          </ul>
        )}
      </Section>

      <p className="measure-wide mt-3 px-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
        The failures-only switch is asked of the server. Open a row to see the
        endpoint, the payload the gateway sent and whatever came back.
      </p>
    </>
  );
}

/**
 * One delivery attempt.
 *
 * ONE ROW IS OPEN AT A TIME, which is the behaviour this page shipped with and
 * is kept exactly: the open state lives on the page rather than in the row, so
 * opening a second attempt closes the first. On a screen whose expansions are
 * multi-line JSON payloads that is the right default — a list where every row
 * has been opened is a list you have to scroll past rather than read.
 */
function LogRow({
  log,
  open,
  onToggle,
}: {
  log: WebhookLog;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="border-t border-[var(--line-soft)] first:border-t-0">
      {/* `min-h-[44px]` is the touch floor, and a disclosure is exactly the
          control that tends to miss it: its height comes from its content, so a
          one-line row lands around 36px without being told otherwise. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-start gap-3 rounded-lg px-1 py-3 text-left outline-none transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
      >
        <ChevronRight
          size={14}
          aria-hidden
          className={`mt-[3px] shrink-0 text-slate-500 transition-transform duration-[var(--dur-pop)] ease-[var(--ease-out)] dark:text-slate-400 ${
            open ? 'rotate-90' : ''
          }`}
        />
        <span className="sr-only">{open ? 'Hide' : 'Show'} delivery detail</span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {/* `break-all` on the event name: it is an unbroken dotted literal
                and there is no space in it for a wrap to land on. */}
            <code className="code break-all font-medium">{log.event}</code>
            {/* The HTTP status is the fact; the word beside it is what makes the
                colour redundant rather than load-bearing. */}
            <Badge tone={log.success ? 'settled' : 'failed'} dot>
              {log.success ? 'ok' : 'failed'}
              {log.statusCode != null && ` · ${log.statusCode}`}
            </Badge>
          </div>
          <p className="mt-1 truncate text-[13px] font-medium text-slate-900 dark:text-slate-100">
            {log.clientName ?? log.clientId}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
            {log.url}
          </p>
          {/* The narrow-viewport home for the facts the right-hand column
              carries from `sm` up. Never both at once. */}
          <p className="num mt-1 text-[11px] text-slate-500 sm:hidden dark:text-slate-400">
            Attempt {log.attempt}
            {log.maxAttempts ? ` / ${log.maxAttempts}` : ''} · {formatDate(log.createdAt)}
          </p>
          <p className="mt-0.5 text-[11px] sm:hidden">
            <RetryNote log={log} />
          </p>
        </div>

        <div className="hidden shrink-0 text-right sm:block">
          <span className="num block text-[11px] text-slate-600 dark:text-slate-300">
            {log.attempt}
            {log.maxAttempts ? ` / ${log.maxAttempts}` : ''}
          </span>
          <span className="num mt-0.5 block whitespace-nowrap text-[11px] text-slate-500 dark:text-slate-400">
            {formatDate(log.createdAt)}
          </span>
          <span className="mt-0.5 block text-[11px]">
            <RetryNote log={log} />
          </span>
        </div>
      </button>

      {open && (
        // Indented to the chevron's gutter so the detail hangs off its row
        // rather than restarting the surface's left edge.
        <div className="pb-5 pl-7 pr-1">
          {/* `auto-fit` rather than a hard two- or four-up: this block is
              already indented 28px, so a fixed grid on a 360px phone gave each
              field about 140px to hold a merchant id. The fields reflow to one
              column when that is what fits. */}
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-x-8">
            <Field label="Client">{log.clientName ?? log.clientId}</Field>
            <Field label="Attempt">
              <span className="num">
                {log.attempt}
                {log.maxAttempts ? ` / ${log.maxAttempts}` : ''}
              </span>
            </Field>
            <Field label="Sent">
              <span className="num">{formatDate(log.createdAt)}</span>
            </Field>
            <Field label="Next retry">
              {log.nextRetryAt ? (
                <span className="num">{formatDate(log.nextRetryAt)}</span>
              ) : (
                <RetryNote log={log} />
              )}
            </Field>
            {/* The full endpoint. The row above truncates it, and a URL you can
                only see the first 60 characters of is not one you can check.
                `break-all` rather than the `overflow-x-auto` this used to carry:
                a 3px-tall horizontal scrollbar is not a way to read an address
                on a phone. */}
            <Field label="Endpoint">
              <span className="break-all font-mono">{log.url}</span>
            </Field>
          </dl>

          <Payload label="Payload" code={renderPayload(log.payload)} />
          {log.response && <Payload label="Response" code={log.response} />}
        </div>
      )}
    </li>
  );
}

/**
 * WHAT HAPPENS NEXT, as a word rather than a blank.
 *
 * Amber only when something really is still owed — a retry is pending and the
 * gateway will act on it. A delivery that succeeded needs nothing, and one with
 * no retries left is finished rather than waiting; painting either amber would
 * spend the "waiting on someone" hue on rows nobody has to come back to.
 */
function RetryNote({ log }: { log: WebhookLog }) {
  if (log.success) {
    return <span className="text-slate-500 dark:text-slate-400">no retry needed</span>;
  }
  if (log.nextRetryAt) {
    return (
      <span className="text-amber-600 dark:text-amber-400">
        retries {relativeTime(log.nextRetryAt)}
      </span>
    );
  }
  return <span className="text-slate-500 dark:text-slate-400">no retry left</span>;
}

/** A ruled key/value of the expanded detail — the spine, at log density. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-t border-[var(--line-soft)] pt-2">
      <dt className="runhead">{label}</dt>
      <dd className="mt-1 break-words text-xs text-slate-700 dark:text-slate-300">{children}</dd>
    </div>
  );
}

/**
 * A JSON payload, on the one deliberately dark ground in the product.
 *
 * It earns the enclosure: this is a verbatim wire body, and it is the same
 * ground the merchant panel prints a payload on, so code looks like code in both
 * themes rather than becoming a pale panel in one of them. The scroller is the
 * `<pre>` itself — a payload must keep its own whitespace, so it scrolls rather
 * than wraps, and it must never be allowed to push the surface it sits on
 * sideways.
 */
function Payload({ label, code }: { label: string; code: string }) {
  return (
    <div className="mt-5">
      <div className="rule pt-3">
        <span className="runhead">{label}</span>
      </div>
      <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}
