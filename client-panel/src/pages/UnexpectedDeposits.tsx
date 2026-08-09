import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, CheckCircle2, ExternalLink, Inbox } from 'lucide-react';
import {
  errorMessage,
  explorerTx,
  listUnexpectedDeposits,
  recoverUnexpectedDeposit,
} from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { UnexpectedDeposit } from '@/types';
import PageHeader from '@/components/PageHeader';
import Spinner, { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';

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
  const open = rows.filter((r) => r.status !== 'swept' && r.status !== 'converted');

  return (
    <>
      <PageHeader
        title="Unexpected deposits"
        description="Funds that arrived at your deposit addresses but couldn't be matched to a payment."
      />

      {q.isLoading ? (
        <LoadingPanel />
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <Inbox size={34} className="text-slate-300 dark:text-slate-700" />
          <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            Nothing unexpected
          </h3>
          <p className="mt-1.5 max-w-md text-sm text-slate-500">
            If a customer ever sends the wrong coin, or pays an invoice after it
            expires, it will appear here so you can recover it. Nothing is lost in
            the meantime — the funds stay at an address only you control.
          </p>
        </div>
      ) : (
        <>
          {open.length > 0 && (
            <div className="mb-5 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <p>
                <strong>
                  {open.length} deposit{open.length === 1 ? '' : 's'} waiting to be
                  recovered.
                </strong>{' '}
                Recovering moves the funds into the gateway's collection wallet, where
                they settle to you like any other balance. The money is safe until
                you do — it is sitting at an address derived from your account.
              </p>
            </div>
          )}

          <div className="space-y-4">
            {rows.map((d) => (
              <Row
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
        </>
      )}
    </>
  );
}

function Row({
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
  const done = d.status === 'swept' || d.status === 'converted';

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-lg font-bold num text-slate-900 dark:text-slate-50">
              {trim(d.amount)} {d.asset}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {d.network}
            </span>
            {wrongCoin ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                wrong coin
              </span>
            ) : (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                late payment
              </span>
            )}
          </div>

          <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
            {wrongCoin ? (
              <>
                Your customer sent <strong>{d.asset}</strong> to an invoice expecting{' '}
                <strong>{d.expectedAsset}</strong>.
              </>
            ) : (
              <>
                {d.asset} arrived after the payment window had already closed.
              </>
            )}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>{formatDate(d.createdAt)}</span>
            <a
              href={explorerTx(d.txHash, d.network)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-brand-600"
            >
              transaction <ExternalLink size={11} />
            </a>
            <code className="font-mono">{d.depositAddress.slice(0, 10)}…</code>
          </div>

          {d.error && !busy && (
            <p className="mt-2 text-xs text-red-600">Last attempt failed: {d.error}</p>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>

        <div className="shrink-0">
          {done ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-brand-50 px-3 py-2 text-sm font-medium text-brand-700 dark:bg-brand-900/25 dark:text-brand-300">
              <CheckCircle2 size={15} /> Recovered
            </span>
          ) : (
            <button className="btn-primary" onClick={onRecover} disabled={busy}>
              {busy ? (
                <Spinner size={15} />
              ) : (
                <>
                  Recover <ArrowRight size={15} />
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function trim(v: string): string {
  if (!v.includes('.')) return v;
  return v.replace(/0+$/, '').replace(/\.$/, '') || '0';
}
