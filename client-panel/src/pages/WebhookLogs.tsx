import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { errorMessage, getWebhookLogs } from '@/lib/api';
import { formatDate, shortHash } from '@/lib/format';
import type { WebhookLog } from '@/types';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import { WebhookStatusBadge } from '@/components/Badge';
import CopyButton from '@/components/CopyButton';

/**
 * Webhook delivery log.
 *
 * ---------------------------------------------------------------------------
 * A LEDGER YOU CAN OPEN, ON ITS OWN SURFACE
 *
 * Not DataTable: a row here expands into a payload, and a disclosure inside a
 * table cell fights the table for width. So it is hand-rolled from the same
 * parts — a Section for the surface and the running head, hairlines between
 * rows, and the same ruled empty/error states DataTable uses, so the two read
 * as one object even though only one of them is a `<table>`.
 *
 * The head used to be a hand-drawn strip closed by a full-weight ink rule
 * (`border-slate-900`), which was the correct gesture in a design made of rules
 * and is a scar in one made of surfaces. `Section` draws that head now, so this
 * page cannot drift away from every other list in the product.
 *
 * MONOSPACE WHERE IT IS A LITERAL. The event name, the endpoint, the HTTP code
 * and the payloads are all strings a developer will compare character by
 * character or paste into a terminal; the prose around them is not. Nothing
 * else on the page is mono.
 *
 * EVERY FACT IN THE ROW IS REACHABLE ON A PHONE. The attempt counter and the
 * sent time used to be in a `hidden sm:block` column, which meant that below
 * 640px the two questions a delivery log is opened to answer — when did this
 * fire, and how many tries in are we — had no answer anywhere on the screen.
 * They now fall under the endpoint on a narrow viewport and stay ranged right
 * on a wide one.
 *
 * MOTION. Exactly one thing moves: the disclosure chevron rotates, keyed to the
 * open state — a value CHANGE, never mount — at --dur-pop, transform only. The
 * refresh icon keeps its spin because a spinner is information about a request
 * in flight, and it carries `motion-keep` for the same reason Spinner does: the
 * reduced-motion catch-all would otherwise freeze it, and a frozen spinner
 * reads as a hung request.
 */

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
    <li className="border-t border-[var(--line-soft)] first:border-t-0">
      {/* `min-h-[44px]` is the touch floor, and a disclosure is exactly the
          control that tends to miss it: its height comes from its content, so a
          one-line row lands around 36px without being told otherwise. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <code className="break-all font-mono text-[13px] font-medium text-slate-900 dark:text-slate-100">
              {log.event}
            </code>
            <WebhookStatusBadge status={log.status} />
            {log.httpStatus !== null && (
              <span className="num font-mono text-[11px] text-slate-500 dark:text-slate-400">
                HTTP {log.httpStatus}
              </span>
            )}
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
            {log.url}
          </p>
          {/* The narrow-viewport home for the two facts the right-hand column
              carries from `sm` up. Never both at once. */}
          <p className="num mt-1 text-[11px] text-slate-500 sm:hidden dark:text-slate-400">
            Attempt {log.attempt} / {log.maxAttempts} · {formatDate(log.createdAt)}
          </p>
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <span className="num block text-[11px] text-slate-600 dark:text-slate-300">
            {log.attempt} / {log.maxAttempts}
          </span>
          <span className="num mt-0.5 block whitespace-nowrap text-[11px] text-slate-500 dark:text-slate-400">
            {formatDate(log.createdAt)}
          </span>
        </div>
      </button>

      {open && (
        // Indented to the chevron's gutter so the detail hangs off its row
        // rather than restarting the surface's left edge.
        <div className="pb-5 pl-7 pr-1">
          {/* `auto-fit` rather than `grid-cols-2 sm:grid-cols-4`: this block is
              already indented 28px, so a hard two-up on a 360px phone gave each
              field about 140px to hold a payment id. The fields now reflow to
              one column when that is what fits. */}
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-x-8">
            {log.paymentId && (
              <Field label="Payment">
                <span className="num break-all font-mono">
                  {shortHash(log.paymentId, 8, 4)}
                </span>
              </Field>
            )}
            <Field label="Attempt">
              <span className="num">
                {log.attempt} / {log.maxAttempts}
              </span>
            </Field>
            <Field label="Sent">
              <span className="num">{formatDate(log.createdAt)}</span>
            </Field>
            {log.nextRetryAt && (
              <Field label="Next retry">
                <span className="num">{formatDate(log.nextRetryAt)}</span>
              </Field>
            )}
            {/* The full endpoint. The row above truncates it, and a URL you can
                only see the first 60 characters of is not one you can check. */}
            <Field label="Endpoint">
              <span className="break-all font-mono">{log.url}</span>
            </Field>
          </dl>

          <Payload label="Request body" code={body || '—'} copy={body} />
          {response && <Payload label="Response" code={response} copy={response} />}
        </div>
      )}
    </li>
  );
}

/** A ruled key/value of the expanded detail — the spine, at log density. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-t border-[var(--line-soft)] pt-2">
      <dt className="runhead">{label}</dt>
      <dd className="mt-1 break-words text-xs text-slate-700 dark:text-slate-300">
        {children}
      </dd>
    </div>
  );
}

/**
 * A JSON payload, on the one deliberately dark ground in the product.
 *
 * It earns the enclosure: this is a verbatim wire body, and it is the same
 * ground CodeBlock uses everywhere else, so code always looks like code in both
 * themes rather than becoming a pale panel in one of them. The scroller is the
 * `<pre>` itself — a payload must keep its own whitespace, so it scrolls rather
 * than wraps, and it must never be allowed to push the surface it sits on
 * sideways.
 */
function Payload({ label, code, copy }: { label: string; code: string; copy: string }) {
  return (
    <div className="mt-5">
      <div className="rule flex items-center justify-between gap-4 pt-3">
        <span className="runhead">{label}</span>
        <CopyButton value={copy} label="Copy" className="-mr-2" />
      </div>
      <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-[12px] leading-relaxed text-slate-100">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

/** Uneven, cycled ghost widths so the placeholder reads as text, not a barcode. */
const GHOST_WIDTHS = ['62%', '38%', '74%', '46%', '30%', '55%'];

export default function WebhookLogs() {
  const query = useQuery({
    queryKey: ['webhook-logs'],
    queryFn: getWebhookLogs,
  });

  const logs = query.data ?? [];
  const failed = logs.filter((l) => l.status === 'failed').length;
  const pending = logs.filter((l) => l.status === 'pending').length;

  return (
    <>
      <PageHeader
        eyebrow="Developers"
        title="Webhook Logs"
        description="Every delivery attempt to your configured endpoint. Failures retry automatically with exponential backoff up to the configured maximum — expand any row to inspect the exact payload we sent."
        actions={
          <button
            className="btn-secondary"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw
              size={16}
              aria-hidden
              // motion-keep: the reduced-motion catch-all in index.css would
              // otherwise freeze this mid-request, and a frozen spinner reads as
              // a hung one. Same exception Spinner takes, for the same reason.
              className={query.isFetching ? 'motion-keep animate-spin' : ''}
            />
            {query.isFetching ? 'Refreshing' : 'Refresh'}
          </button>
        }
        meta={
          query.data ? (
            <>
              {logs.length} {logs.length === 1 ? 'attempt' : 'attempts'}
              {failed > 0 && (
                <>
                  {' · '}
                  <span className="text-red-600 dark:text-red-400">{failed} failed</span>
                </>
              )}
              {pending > 0 && (
                <>
                  {' · '}
                  <span className="text-amber-600 dark:text-amber-400">
                    {pending} pending
                  </span>
                </>
              )}
            </>
          ) : undefined
        }
      />

      {/* `flush`, for the same reason a table gets it: the rows draw their own
          hairlines edge to edge and body padding would inset them from the
          rules that divide them. The `aside` is the second running head — what
          the right-hand column of each row holds, named once at the top. */}
      <Section
        flush
        title="Delivery"
        aside={<span className="runhead hidden sm:block">Attempt · Sent</span>}
      >
        {query.isLoading ? (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading…
            </span>
            {GHOST_WIDTHS.map((w, i) => (
              <div
                key={w}
                className="border-t border-[var(--line-soft)] py-4 first:border-t-0"
              >
                {/* Static, stepped down the page: the frequency boundary bans a
                    loop on a surface opened this often, so shape and opacity do
                    the work a shimmer used to. */}
                <span
                  aria-hidden
                  className="ghost h-3"
                  style={{ width: w, opacity: Math.max(0.25, 1 - i * 0.12) }}
                />
              </div>
            ))}
          </div>
        ) : query.isError ? (
          <div className="py-12">
            <span className="runhead text-red-600 dark:text-red-400">
              Could not load
            </span>
            <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
              {errorMessage(query.error)}
            </p>
            <button
              type="button"
              className="btn-secondary mt-5"
              onClick={() => query.refetch()}
            >
              Retry
            </button>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-12">
            <span className="runhead">Nothing here</span>
            <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
              No webhook deliveries yet.
            </p>
            <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Attempts appear the moment an event fires. If you are expecting one,
              check that a webhook URL is set under Settings.
            </p>
          </div>
        ) : (
          <ul>
            {logs.map((log) => (
              <LogRow key={log.id} log={log} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
