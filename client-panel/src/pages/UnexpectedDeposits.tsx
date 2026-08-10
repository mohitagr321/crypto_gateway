import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, ExternalLink } from 'lucide-react';
import {
  errorMessage,
  explorerTx,
  listUnexpectedDeposits,
  recoverUnexpectedDeposit,
} from '@/lib/api';
import { formatDate, shortHash } from '@/lib/format';
import type { UnexpectedDeposit } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import Badge from '@/components/Badge';
import Spinner from '@/components/Spinner';

/**
 * Funds that reached one of this merchant's deposit addresses but could not be
 * credited to a payment.
 *
 * Before this page existed they were invisible: the listener ignored them, the
 * payment expired, and the money sat at an HD address nobody thought to look at.
 * It was never LOST — the key is derivable — but recovering it meant an operator
 * running a CLI by hand.
 *
 * Two situations land here, and the wording distinguishes them because the
 * customer conversation is different:
 *   - WRONG COIN  — they sent USDC to a USDT invoice.
 *   - LATE PAYMENT — right coin, but the invoice had already expired.
 *
 * SET AS AN EXCEPTION QUEUE, not as a list. The page is split in two: the
 * deposits that still need a decision are entries — one hairline each, the
 * amount set large, the recover action ranged right where the eye lands after
 * reading the row — and the ones already dealt with collapse into a dense
 * ledger underneath. A queue where the outstanding item and the settled one
 * look identical is a queue that gets ignored.
 */
export default function UnexpectedDeposits() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['unexpected-deposits'],
    queryFn: listUnexpectedDeposits,
  });

  const recover = useMutation({
    mutationFn: (id: string) => recoverUnexpectedDeposit(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['unexpected-deposits'] }),
  });

  const rows = q.data ?? [];
  // Unchanged predicate: anything not yet swept or converted is still open, and
  // that deliberately includes `failed` — a failed sweep is retryable, and the
  // money is still sitting there.
  const open = rows.filter((r) => r.status !== 'swept' && r.status !== 'converted');
  const resolved = rows.filter((r) => r.status === 'swept' || r.status === 'converted');

  const resolvedColumns: Column<UnexpectedDeposit>[] = [
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortValue: (d) => Number(d.amount),
      render: (d) => (
        <span className="font-medium text-slate-900 dark:text-slate-50">
          {trim(d.amount)}
        </span>
      ),
    },
    {
      key: 'asset',
      header: 'Asset',
      sortValue: (d) => `${d.asset} · ${d.network}`,
      render: (d) => (
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {d.asset} · {d.network}
        </span>
      ),
    },
    {
      key: 'convertedTo',
      header: 'Recovered as',
      hideOnMobile: true,
      render: (d) =>
        d.convertedTo ? (
          <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
            <span className="num">{trim(d.convertedAmount ?? '0')}</span>{' '}
            {d.convertedTo}
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (d) => d.status,
      render: (d) => (
        <Badge tone="settled" dot>
          {d.status}
        </Badge>
      ),
    },
    {
      key: 'txHash',
      header: 'Transaction',
      hideOnMobile: true,
      render: (d) => (
        <a
          href={explorerTx(d.txHash, d.network)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 hover:underline dark:text-brand-400"
        >
          {shortHash(d.txHash)}
          <ExternalLink size={11} aria-hidden />
        </a>
      ),
    },
    {
      key: 'createdAt',
      header: 'Arrived',
      hideOnMobile: true,
      align: 'right',
      className: 'num',
      sortValue: (d) => new Date(d.createdAt).getTime(),
      render: (d) => (
        <span className="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">
          {formatDate(d.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Money in"
        title="Unexpected deposits"
        description="Funds that arrived at your deposit addresses but couldn't be matched to a payment."
        meta={
          rows.length > 0
            ? `${open.length} waiting · ${rows.length} total`
            : undefined
        }
      />

      {q.isLoading ? (
        <div className="space-y-8" aria-busy="true">
          <span className="sr-only" role="status">
            Loading unexpected deposits…
          </span>
          {[0, 1].map((i) => (
            <div key={i} className="rule pt-4">
              <span className="ghost h-3 w-24" aria-hidden />
              <span className="ghost mt-3 h-8 w-48" aria-hidden />
              <span
                className="ghost mt-3 h-3 w-2/3"
                aria-hidden
                style={{ opacity: 1 - i * 0.35 }}
              />
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <div className="rule pt-3">
          <span className="runhead text-red-600 dark:text-red-400">
            Could not load
          </span>
          <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
            {errorMessage(q.error)}
          </p>
          <button
            type="button"
            className="btn-secondary mt-5"
            onClick={() => q.refetch()}
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rule pt-3">
          <span className="runhead">Nothing unexpected</span>
          <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
            Every deposit so far has matched a payment.
          </p>
          <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            If a customer ever sends the wrong coin, or pays an invoice after it
            expires, it will appear here so you can recover it. Nothing is lost in
            the meantime — the funds stay at an address only you control.
          </p>
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="mb-9 flex gap-3">
              {/* amber = waiting on someone. The word "waiting" carries the
                  same meaning for anyone who cannot see the hue. */}
              <AlertTriangle
                size={17}
                className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden
              />
              <div className="min-w-0">
                <span className="runhead text-amber-600 dark:text-amber-400">
                  {open.length} deposit{open.length === 1 ? '' : 's'} waiting to be
                  recovered
                </span>
                <p className="measure-wide mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  Recovering moves the funds into the gateway's collection wallet,
                  where they settle to you like any other balance. The money is safe
                  until you do — it is sitting at an address derived from your
                  account.
                </p>
              </div>
            </div>
          )}

          {open.length > 0 && (
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-4">
                <span className="runhead">Waiting to recover</span>
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  {open.length}
                </span>
              </div>
              <div className="space-y-7">
                {open.map((d) => (
                  <OpenEntry
                    key={d.id}
                    d={d}
                    busy={recover.isPending && recover.variables === d.id}
                    error={
                      recover.isError && recover.variables === d.id
                        ? errorMessage(recover.error)
                        : null
                    }
                    onRecover={() => recover.mutate(d.id)}
                  />
                ))}
              </div>
            </section>
          )}

          {resolved.length > 0 && (
            <section className={open.length > 0 ? 'mt-14' : ''}>
              <div className="rule flex items-baseline justify-between gap-4 pb-3 pt-3">
                <span className="runhead">Recovered</span>
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  {resolved.length} record{resolved.length === 1 ? '' : 's'}
                </span>
              </div>
              <DataTable
                columns={resolvedColumns}
                rows={resolved}
                rowKey={(d) => d.id}
                label="Recovered deposits"
                emptyLabel="Nothing recovered yet."
                renderMobile={(d) => (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {d.asset} · {d.network}
                      </p>
                      <p className="num mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {formatDate(d.createdAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num lining-nums text-base font-semibold text-slate-900 dark:text-slate-50">
                        {trim(d.amount)}
                      </p>
                      <div className="mt-1.5 flex justify-end">
                        <Badge tone="settled" dot>
                          {d.status}
                        </Badge>
                      </div>
                    </div>
                  </div>
                )}
              />
            </section>
          )}
        </>
      )}
    </>
  );
}

/**
 * One outstanding deposit, set as an entry rather than a card.
 *
 * The amount is the largest thing in the block because it is the thing being
 * decided about, and the action is ranged right on the same baseline as the
 * classification so the row reads WHAT HAPPENED → HOW MUCH → WHAT TO DO. On a
 * phone the button drops full-width beneath the explanation rather than
 * shrinking into the corner.
 */
function OpenEntry({
  d,
  busy,
  error,
  onRecover,
}: {
  d: UnexpectedDeposit;
  busy: boolean;
  error: string | null;
  onRecover: () => void;
}) {
  const wrongCoin = Boolean(d.expectedAsset && d.expectedAsset !== d.asset);
  const failed = d.status === 'failed';

  return (
    <article className="rule grid gap-x-8 gap-y-4 pt-4 md:grid-cols-12">
      <div className="min-w-0 md:col-span-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* Both classifications are amber: in each one something is still
              owed to somebody. The WORD is what tells them apart. */}
          <Badge tone="waiting" dot>
            {wrongCoin ? 'wrong coin' : 'late payment'}
          </Badge>
          <Badge tone={failed ? 'failed' : 'neutral'}>{d.status}</Badge>
        </div>

        <p className="figure-lg mt-2.5">
          {trim(d.amount)}{' '}
          {/* Asset and network are one label, never two independent facts. */}
          <span className="text-base font-medium tracking-normal text-slate-500 dark:text-slate-400">
            {d.asset} · {d.network}
          </span>
        </p>

        <p className="measure mt-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          {wrongCoin ? (
            <>
              Your customer sent <strong>{d.asset}</strong> to an invoice expecting{' '}
              <strong>{d.expectedAsset}</strong>.
            </>
          ) : (
            <>{d.asset} arrived after the payment window had already closed.</>
          )}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="num">{formatDate(d.createdAt)}</span>
          <a
            href={explorerTx(d.txHash, d.network)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-brand-600 dark:hover:text-brand-400"
          >
            transaction <ExternalLink size={11} aria-hidden />
          </a>
          <code className="font-mono">{shortHash(d.depositAddress, 10, 4)}</code>
        </div>

        {d.error && !busy && (
          <p className="measure mt-3 text-xs leading-relaxed text-red-600 dark:text-red-400">
            Last attempt failed: {d.error}
          </p>
        )}
        {error && (
          <p className="measure mt-3 text-xs leading-relaxed text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      <div className="md:col-span-4 md:flex md:justify-end">
        <button
          className="btn-primary w-full md:w-auto"
          onClick={onRecover}
          disabled={busy}
        >
          {busy ? (
            <Spinner size={15} />
          ) : (
            <>
              Recover <ArrowRight size={15} aria-hidden />
            </>
          )}
        </button>
      </div>
    </article>
  );
}

/**
 * Trailing-zero trim, and deliberately NOT `formatAmount`.
 *
 * These are raw chain amounts at full token precision, and formatAmount caps at
 * six fraction digits — which would render a dust deposit of 0.000000123 as
 * "0" on the one page whose entire purpose is to say that this money exists.
 */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  return v.replace(/0+$/, '').replace(/\.$/, '') || '0';
}
