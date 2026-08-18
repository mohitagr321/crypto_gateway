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
import Section from '@/components/Section';
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
 * SET AS AN EXCEPTION QUEUE, not as a list, and that survives the redesign
 * because it is the whole point of the page: a queue where the outstanding item
 * and the settled one look identical is a queue that gets ignored.
 *
 * What carries the split is no longer a hairline. It is two titled surfaces —
 * "Waiting to recover" holds entries set at reading weight, with the amount
 * large and a primary control on each; "Recovered" holds a dense ledger of rows
 * with no controls at all. The difference between a block you act on and a row
 * you skim is now structural rather than typographic, which is a stronger signal
 * and one that still reads at a glance on a phone, where the two sections are
 * stacked and the eye never sees them side by side to compare.
 *
 * NOTHING GETS A PER-CARD ACCENT HUE. Amber appears exactly where it means
 * "waiting on someone" — the callout, the classification badge — and never as
 * decoration on the surfaces themselves.
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

      {/* Every non-row state takes a surface too, and for the same reason the
          real content does: a page whose loading, error and empty states are
          bare text on the canvas looks broken in exactly the moments it most
          needs to look deliberate. The skeleton draws the surface it resolves
          into, so nothing steps down the page when the fetch lands. */}
      {q.isLoading ? (
        <div className="grid gap-3" aria-busy="true">
          <span className="sr-only" role="status">
            Loading unexpected deposits…
          </span>
          {[0, 1].map((i) => (
            <div key={i} className="surface p-4 sm:p-5">
              <span className="ghost h-3 w-24" aria-hidden />
              <span className="ghost mt-3 h-8 w-48 max-w-full" aria-hidden />
              <span
                className="ghost mt-3 h-3 w-2/3"
                aria-hidden
                // Stepped down the page so the block reads as "not loaded yet"
                // without a single frame of animation.
                style={{ opacity: 1 - i * 0.35 }}
              />
            </div>
          ))}
        </div>
      ) : q.isError ? (
        <div className="surface p-4 sm:p-5">
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
        <div className="surface p-4 sm:p-5">
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
            /* The standing explanation of what "recover" does, on its own
               surface above the queue. It is read once and then never again,
               which is exactly why it must not be mistaken for one of the
               entries below it — a surface with no figure and no control reads
               as a note rather than as work. */
            <div className="surface flex gap-3 p-4 sm:p-5">
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
            /* ONE surface holding the whole queue, rather than one surface per
               deposit. Nesting a raised card inside a raised section would put
               two elevation steps on the same z-plane, which is the fastest way
               to make a page read as a pile of boxes; the entries are divided
               from each other by a hairline instead — the job a rule is
               genuinely good at now that it is no longer carrying the page. */
            <Section
              className="mt-3"
              title="Waiting to recover"
              aside={
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  {open.length}
                </span>
              }
            >
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
            </Section>
          )}

          {resolved.length > 0 && (
            <Section
              className="mt-3"
              flush
              title="Recovered"
              aside={
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  {resolved.length} record{resolved.length === 1 ? '' : 's'}
                </span>
              }
            >
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
                      {/* WHAT THE MERCHANT ACTUALLY GOT. `Recovered as` is a
                          `hideOnMobile` column, so the stacked row used to state
                          the amount that arrived and stay silent about the
                          amount that was credited — which is the outcome, and
                          the only reason to read a resolved row at all. */}
                      {d.convertedTo && (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                          recovered as{' '}
                          <span className="num">{trim(d.convertedAmount ?? '0')}</span>{' '}
                          {d.convertedTo}
                        </p>
                      )}
                    </div>
                    {/* `min-w-0` and `break-words` rather than `shrink-0`: these
                        are raw chain amounts at full token precision, so a dust
                        recovery can run to twenty characters. A money figure is
                        never allowed to be clipped by its own column. */}
                    <div className="min-w-0 text-right">
                      <p className="num lining-nums break-words text-base font-semibold text-slate-900 dark:text-slate-50">
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
            </Section>
          )}
        </>
      )}
    </>
  );
}

/**
 * One outstanding deposit, set as an entry inside the queue's surface rather
 * than as a card of its own — see the note at the call site for why a card
 * inside a card is the wrong move here.
 *
 * The amount is the largest thing in the block because it is the thing being
 * decided about, and the action is ranged right on the same baseline as the
 * classification so the row reads WHAT HAPPENED → HOW MUCH → WHAT TO DO. On a
 * phone the button drops full-width beneath the explanation rather than
 * shrinking into the corner.
 *
 * The dividing rule falls BETWEEN entries only: `first:` drops it on the top
 * entry, where it would double the stroke the Section header already draws, and
 * the last entry loses its bottom padding so the surface closes on the button
 * rather than on a band of empty space.
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
    <article className="rule grid gap-x-8 gap-y-4 py-5 first:border-t-0 first:pt-0 last:pb-0 md:grid-cols-12">
      <div className="min-w-0 md:col-span-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {/* Both classifications are amber: in each one something is still
              owed to somebody. The WORD is what tells them apart. */}
          <Badge tone="waiting" dot>
            {wrongCoin ? 'wrong coin' : 'late payment'}
          </Badge>
          <Badge tone={failed ? 'failed' : 'neutral'}>{d.status}</Badge>
        </div>

        {/* `break-words` on the figure, and no `text-*` utility anywhere near
            it. These are raw chain amounts at full token precision, so this is
            the one figure in the product that can genuinely run long — and a
            size utility would beat `.figure-lg`'s clamp in the cascade and pin
            it to one size at every viewport, which is a bug this codebase has
            already shipped once. */}
        <p className="figure-lg mt-2.5 break-words">
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
          {/* 44px of hit area below `sm`, relaxing to the pointer height at
              `sm` — the same floor `.btn` enforces. This link is how a merchant
              checks the deposit on-chain before recovering it, and at its old
              16px it was a target a thumb could not reliably find. */}
          <a
            href={explorerTx(d.txHash, d.network)}
            target="_blank"
            rel="noopener noreferrer"
            className="-mx-1 inline-flex min-h-[44px] items-center gap-1 rounded-sm px-1 hover:text-brand-600 sm:min-h-0 dark:hover:text-brand-400"
          >
            transaction <ExternalLink size={11} className="shrink-0" aria-hidden />
          </a>
          {/* An address is one unbreakable token; elided here, but `break-all`
              is what stops it setting the entry's minimum width on a phone. */}
          <code className="break-all font-mono">
            {shortHash(d.depositAddress, 10, 4)}
          </code>
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
