import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Ban,
  Pause,
  Play,
  Plus,
  Repeat,
} from 'lucide-react';
import {
  checkoutUrl,
  createSubscription,
  errorMessage,
  getRates,
  getSubscriptionInvoices,
  listSubscriptions,
  setSubscriptionStatus,
} from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { IntervalUnit, Subscription } from '@/types';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import Spinner, { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import Badge from '@/components/Badge';

/**
 * Recurring billing.
 *
 * A subscription here is a SCHEDULE, not a standing charge: each cycle issues an
 * invoice the customer chooses to pay. There is no stored mandate to pull funds
 * from — crypto has no direct-debit — and the page says so plainly rather than
 * implying a card-style subscription that does not exist.
 */
export default function Subscriptions() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<Subscription | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('month');
  const [intervalCount, setIntervalCount] = useState('1');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [dueDays, setDueDays] = useState('7');
  const [autoSend, setAutoSend] = useState(true);

  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: listSubscriptions });
  const rates = useQuery({ queryKey: ['rates'], queryFn: getRates, staleTime: 60_000 });

  const history = useQuery({
    queryKey: ['subscription-invoices', historyFor?.id],
    queryFn: () => getSubscriptionInvoices(historyFor!.id),
    enabled: Boolean(historyFor),
  });

  const reset = () => {
    setTitle('');
    setDescription('');
    setAmount('');
    setIntervalCount('1');
    setCustomerName('');
    setCustomerEmail('');
    setDueDays('7');
    setAutoSend(true);
  };

  const create = useMutation({
    mutationFn: () =>
      createSubscription({
        title: title.trim(),
        description: description.trim() || undefined,
        amount: amount.trim(),
        currency,
        intervalUnit,
        intervalCount: Number(intervalCount) || 1,
        customerName: customerName.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        dueDays: Number(dueDays) || 0,
        // Emailing each invoice needs somewhere to send it; the server refuses
        // the combination too, but there is no reason to make it say so.
        autoSend: autoSend && Boolean(customerEmail.trim()),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      reset();
      qc.invalidateQueries({ queryKey: ['subscriptions'] });
    },
  });

  const change = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'pause' | 'resume' | 'cancel' }) =>
      setSubscriptionStatus(id, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['subscriptions'] }),
  });

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Bill a customer on a schedule. Each cycle issues an invoice they can pay in any coin you accept."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New subscription
          </button>
        }
      />

      {subs.isLoading ? (
        <LoadingPanel />
      ) : subs.isError ? (
        <ErrorState message={errorMessage(subs.error)} onRetry={() => subs.refetch()} />
      ) : subs.data && subs.data.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <Repeat size={34} className="text-slate-300 dark:text-slate-700" />
          <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            No subscriptions yet
          </h3>
          <p className="mt-1.5 max-w-sm text-sm text-slate-500">
            Set an amount and an interval. Each cycle we create an invoice and, if
            you like, email it to your customer automatically.
          </p>
          <button className="btn-primary mt-6" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Create your first subscription
          </button>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {subs.data?.map((s) => (
            <div key={s.id} className="card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                    {s.title}
                  </h3>
                  <p className="mt-0.5 text-sm text-slate-500">
                    <span className="num font-medium text-slate-700 dark:text-slate-300">
                      {s.currency} {trim(s.amount)}
                    </span>{' '}
                    · every {cadence(s.intervalCount, s.intervalUnit)}
                  </p>
                </div>
                <StatusBadge status={s.status} />
              </div>

              {s.status === 'needs_attention' && (
                <div className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-300">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span>
                    This fell too far behind schedule to catch up on its own, so
                    billing stopped rather than sending a burst of back-dated
                    invoices. Resume it to restart on a clean schedule — the
                    missed cycles are not billed.
                  </span>
                </div>
              )}

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-slate-500">Customer</dt>
                  <dd className="truncate text-slate-700 dark:text-slate-300">
                    {s.customerName ?? s.customerEmail ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">
                    {s.status === 'canceled' ? 'Ended' : 'Next invoice'}
                  </dt>
                  <dd className="text-slate-700 dark:text-slate-300">
                    {s.status === 'canceled' ? '—' : formatDate(s.nextRunAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Billed</dt>
                  <dd className="text-slate-700 dark:text-slate-300">
                    {s.cyclesBilled}
                    {s.totalCycles !== null && ` of ${s.totalCycles}`} cycle
                    {s.cyclesBilled === 1 ? '' : 's'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500">Auto-send</dt>
                  <dd className="text-slate-700 dark:text-slate-300">
                    {s.autoSend ? 'On' : 'Off'}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  className="btn-secondary text-xs"
                  onClick={() => setHistoryFor(s)}
                >
                  Billing history
                </button>
                {s.status === 'active' && (
                  <button
                    className="btn-secondary text-xs"
                    onClick={() => change.mutate({ id: s.id, action: 'pause' })}
                    disabled={change.isPending}
                  >
                    <Pause size={14} /> Pause
                  </button>
                )}
                {(s.status === 'paused' || s.status === 'needs_attention') && (
                  <button
                    className="btn-secondary text-xs"
                    onClick={() => change.mutate({ id: s.id, action: 'resume' })}
                    disabled={change.isPending}
                  >
                    <Play size={14} /> Resume
                  </button>
                )}
                {s.status !== 'canceled' && (
                  <button
                    className="btn-secondary text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                    onClick={() => change.mutate({ id: s.id, action: 'cancel' })}
                    disabled={change.isPending}
                  >
                    <Ban size={14} /> Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {change.isError && (
        <p className="mt-3 text-sm text-red-600">{errorMessage(change.error)}</p>
      )}

      {/* ---------------- Create ---------------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New subscription"
        footer={
          <>
            <button
              className="btn-secondary"
              onClick={() => setCreateOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => create.mutate()}
              disabled={create.isPending || !title.trim() || !amount.trim()}
            >
              {create.isPending ? <Spinner size={16} /> : 'Start billing'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="label" htmlFor="sub-title">
              What are you billing for?
            </label>
            <input
              id="sub-title"
              className="input"
              placeholder="Pro plan"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="sub-currency">
                Currency
              </label>
              <select
                id="sub-currency"
                className="input"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {(rates.data?.currencies ?? ['USD']).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="sub-amount">
                Amount per cycle
              </label>
              <input
                id="sub-amount"
                className="input num"
                inputMode="decimal"
                placeholder="1499"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sub-count">
                Bill every
              </label>
              <div className="flex gap-2">
                <input
                  id="sub-count"
                  className="input num w-20"
                  inputMode="numeric"
                  value={intervalCount}
                  onChange={(e) => setIntervalCount(e.target.value)}
                />
                <select
                  className="input flex-1"
                  value={intervalUnit}
                  onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                  aria-label="Interval unit"
                >
                  <option value="day">day(s)</option>
                  <option value="week">week(s)</option>
                  <option value="month">month(s)</option>
                  <option value="year">year(s)</option>
                </select>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                The first invoice is issued straight away.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="sub-due">
                Payment terms
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="sub-due"
                  className="input num w-20"
                  inputMode="numeric"
                  value={dueDays}
                  onChange={(e) => setDueDays(e.target.value)}
                />
                <span className="text-sm text-slate-500">days to pay</span>
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sub-cust">
                Customer name
              </label>
              <input
                id="sub-cust"
                className="input"
                placeholder="Priya Raman"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <label className="label" htmlFor="sub-email">
                Customer email
              </label>
              <input
                id="sub-email"
                type="email"
                className="input"
                placeholder="priya@example.com"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-start gap-2.5 text-sm text-slate-600 dark:text-slate-400">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
              disabled={!customerEmail.trim()}
            />
            <span>
              Email each invoice automatically
              <span className="mt-0.5 block text-xs text-slate-500">
                {customerEmail.trim()
                  ? 'Sent to the customer as soon as each cycle is issued.'
                  : 'Add a customer email address to enable this.'}
              </span>
            </span>
          </label>

          <div>
            <label className="label" htmlFor="sub-desc">
              Description <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="sub-desc"
              className="input"
              placeholder="Monthly SaaS subscription"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </div>

          {create.isError && (
            <p className="text-sm text-red-600">{errorMessage(create.error)}</p>
          )}
        </div>
      </Modal>

      {/* ---------------- Billing history ---------------- */}
      <Modal
        open={Boolean(historyFor)}
        onClose={() => setHistoryFor(null)}
        title={historyFor ? `${historyFor.title} — billing history` : ''}
      >
        {history.isLoading ? (
          <LoadingPanel />
        ) : history.data && history.data.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Nothing billed yet. The first invoice appears here once the next cycle
            runs.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700">
              <tr>
                <th className="py-2 font-medium">Cycle</th>
                <th className="py-2 font-medium">Invoice</th>
                <th className="py-2 text-right font-medium">Amount</th>
                <th className="py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {history.data?.map((row) => (
                <tr key={row.id}>
                  <td className="py-2 text-slate-500">{row.cycle_number}</td>
                  <td className="py-2">
                    {row.token ? (
                      <a
                        href={checkoutUrl(row.token)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-brand-600 hover:underline"
                      >
                        {row.number}
                      </a>
                    ) : (
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {row.number}
                      </span>
                    )}
                  </td>
                  <td className="num py-2 text-right text-slate-700 dark:text-slate-300">
                    {row.currency} {trim(row.total)}
                  </td>
                  <td className="py-2">
                    <Badge tone={row.status === 'paid' ? 'green' : 'blue'} dot>
                      {row.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
    </>
  );
}

function StatusBadge({ status }: { status: Subscription['status'] }) {
  const tone =
    status === 'active'
      ? 'green'
      : status === 'paused'
        ? 'yellow'
        : status === 'needs_attention'
          ? 'red'
          : 'gray';
  return (
    <Badge tone={tone} dot>
      {status === 'needs_attention' ? 'needs attention' : status}
    </Badge>
  );
}

function cadence(count: number, unit: string): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}

function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
}
