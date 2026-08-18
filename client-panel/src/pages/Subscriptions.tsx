import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Pause, Play, Plus } from 'lucide-react';
import {
  checkoutUrl,
  createSubscription,
  errorMessage,
  getRates,
  getSubscriptionInvoices,
  listSubscriptions,
  setSubscriptionStatus,
} from '@/lib/api';
import { formatAmount, formatDate, formatDateShort } from '@/lib/format';
import type { IntervalUnit, Subscription } from '@/types';
import PageHeader from '@/components/PageHeader';
import Modal from '@/components/Modal';
import Spinner from '@/components/Spinner';
import Badge from '@/components/Badge';
import Section from '@/components/Section';
import DataTable, { type Column } from '@/components/DataTable';

/**
 * Recurring billing.
 *
 * A subscription here is a SCHEDULE, not a standing charge: each cycle issues an
 * invoice the customer chooses to pay. There is no stored mandate to pull funds
 * from — crypto has no direct-debit — and the page says so plainly rather than
 * implying a card-style subscription that does not exist.
 *
 * Set as a ledger rather than a grid of cards. A card grid gave every
 * subscription its own bordered box and repeated eight labels inside each one,
 * so four subscriptions cost four screens and nothing could be compared down a
 * column. The schedule IS a table: what, who, how much, how often, when next.
 * The long-form facts — description, payment terms, auto-send, and the reason a
 * subscription stopped — live one click away in the detail view, which is also
 * where the billing history was already kept.
 *
 * ONE LEDGER, ONE SURFACE. That distinction is the whole of the redesign here:
 * the table is now placed ON a lit surface rather than printed on the page, and
 * so are the two things that used to hang off hairlines beside it — the
 * needs-attention note and the outcome of the last pause/resume/cancel. Three
 * ruled bands stacked in a column read as one undifferentiated run of type;
 * three surfaces read as three things.
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

  const summary = useMemo(() => {
    const list = subs.data ?? [];
    return {
      count: list.length,
      active: list.filter((s) => s.status === 'active').length,
      stalled: list.filter((s) => s.status === 'needs_attention'),
    };
  }, [subs.data]);

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

  /**
   * Pause / resume / cancel. A plain function rather than a component so it
   * closes over the mutation, and wrapped so a click on a control never also
   * opens the row. Every button carries a title AND an aria-label: an icon on
   * its own is not a word, and these three change what a customer gets billed.
   *
   * 44px UNTIL `sm`, for the same reason `.btn` carries the floor: these were
   * 28px squares, and on a phone the cancel control sat four pixels from the
   * pause control. Getting that wrong stops a customer's billing.
   */
  const rowActions = (s: Subscription, justify: 'justify-start' | 'justify-end') => (
    <div
      className={`flex items-center ${justify}`}
      onClick={(e) => e.stopPropagation()}
    >
      {s.status === 'active' && (
        <button
          type="button"
          className={`${ICON_ACTION} hover:bg-[var(--hover)] hover:text-slate-700 dark:hover:text-slate-200`}
          onClick={() => change.mutate({ id: s.id, action: 'pause' })}
          disabled={change.isPending}
          title="Pause billing"
          aria-label={`Pause ${s.title}`}
        >
          <Pause size={14} />
        </button>
      )}
      {(s.status === 'paused' || s.status === 'needs_attention') && (
        <button
          type="button"
          className={`${ICON_ACTION} hover:bg-[var(--hover)] hover:text-slate-700 dark:hover:text-slate-200`}
          onClick={() => change.mutate({ id: s.id, action: 'resume' })}
          disabled={change.isPending}
          title="Resume billing"
          aria-label={`Resume ${s.title}`}
        >
          <Play size={14} />
        </button>
      )}
      {s.status !== 'canceled' && (
        <button
          type="button"
          className={`${ICON_ACTION} hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400`}
          onClick={() => change.mutate({ id: s.id, action: 'cancel' })}
          disabled={change.isPending}
          title="Cancel this subscription"
          aria-label={`Cancel ${s.title}`}
        >
          <Ban size={14} />
        </button>
      )}
    </div>
  );

  const columns: Column<Subscription>[] = [
    {
      key: 'title',
      header: 'Billing for',
      sortValue: (s) => s.title,
      render: (s) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">{s.title}</span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      sortValue: (s) => s.customerName ?? s.customerEmail ?? '',
      render: (s) =>
        s.customerName ??
        s.customerEmail ?? <span className="text-slate-500 dark:text-slate-400">—</span>,
      className: 'text-slate-600 dark:text-slate-400',
    },
    {
      key: 'amount',
      header: 'Per cycle',
      numeric: true,
      sortValue: (s) => Number(s.amount) || 0,
      render: (s) => (
        <span className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
          <span className="font-normal text-slate-500 dark:text-slate-400">{s.currency}</span>{' '}
          {formatAmount(s.amount)}
        </span>
      ),
    },
    {
      key: 'cadence',
      header: 'Cadence',
      // Sorted by the length of one cycle, not by the word: "every 2 weeks"
      // belongs between "every week" and "every month", where an alphabetical
      // sort would put it after "every year".
      sortValue: (s) => s.intervalCount * UNIT_DAYS[s.intervalUnit],
      render: (s) => (
        <span className="whitespace-nowrap text-slate-600 dark:text-slate-400">
          every {cadence(s.intervalCount, s.intervalUnit)}
        </span>
      ),
    },
    {
      key: 'next',
      header: 'Next invoice',
      sortValue: (s) => (s.status === 'canceled' ? '' : s.nextRunAt),
      render: (s) =>
        s.status === 'canceled' ? (
          <span className="text-slate-500 dark:text-slate-400">ended</span>
        ) : (
          <span className="num whitespace-nowrap">{formatDateShort(s.nextRunAt)}</span>
        ),
    },
    {
      key: 'cycles',
      header: 'Billed',
      hideOnMobile: true,
      sortValue: (s) => s.cyclesBilled,
      render: (s) => (
        <span className="num whitespace-nowrap text-slate-600 dark:text-slate-400">
          {s.cyclesBilled}
          {s.totalCycles !== null && ` of ${s.totalCycles}`}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (s) => STATUS_RANK[s.status],
      render: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (s) => rowActions(s, 'justify-end'),
    },
  ];

  /** Eight columns is a phone's worst nightmare; below `md` each one stacks. */
  const renderMobile = (s: Subscription) => (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-medium text-slate-900 dark:text-slate-100">
          {s.title}
        </span>
        <span className="num shrink-0 font-medium text-slate-900 dark:text-slate-100">
          <span className="font-normal text-slate-500 dark:text-slate-400">{s.currency}</span>{' '}
          {formatAmount(s.amount)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="truncate text-sm text-slate-500 dark:text-slate-400">
          every {cadence(s.intervalCount, s.intervalUnit)}
          {s.status !== 'canceled' && <> · next {formatDateShort(s.nextRunAt)}</>}
        </span>
        <StatusBadge status={s.status} />
      </div>
      {/* Pulled left so the first glyph ranges with the text above it rather
          than with the 44px box drawn around it. */}
      <div className="-ml-3 mt-1">{rowActions(s, 'justify-start')}</div>
    </div>
  );

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title="Subscriptions"
        description="Bill a customer on a schedule. Each cycle issues an invoice they can pay in any coin you accept."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New subscription
          </button>
        }
        meta={
          subs.data
            ? `${summary.count} ${
                summary.count === 1 ? 'subscription' : 'subscriptions'
              } · ${summary.active} active`
            : undefined
        }
      />

      {/* Stated ONCE, above the ledger, rather than repeated inside every card
          that happens to be stalled. The status column says which rows; this
          says what it means and what to do. */}
      {summary.stalled.length > 0 && (
        <div className="mb-4">
          <AttentionNote names={summary.stalled.map((s) => s.title)} />
        </div>
      )}

      {/* The schedule, on its own titled surface. `flush` because a table
          ranges to the edges of the surface it sits on. */}
      <Section flush title="All subscriptions">
        <DataTable
          columns={columns}
          rows={subs.data ?? []}
          rowKey={(s) => s.id}
          loading={subs.isLoading}
          error={subs.isError ? errorMessage(subs.error) : null}
          onRetry={() => subs.refetch()}
          // The row opens the subscription: its terms, and every invoice it has
          // ever issued.
          onRowClick={(s) => setHistoryFor(s)}
          renderMobile={renderMobile}
          label="Subscriptions"
          skeletonRows={5}
          emptyLabel="No subscriptions yet."
          emptyHint="Set an amount and an interval. Each cycle we create an invoice and, if you like, email it to your customer automatically."
          emptyAction={
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Create your first subscription
            </button>
          }
        />
      </Section>

      {/* A failed pause/resume/cancel gets a surface of its own: the row above
          it still shows the state the merchant just tried to change, so this
          has to read as a separate object rather than as a footnote. */}
      {change.isError && (
        <div className="surface mt-4 p-4" role="status" aria-live="polite">
          <p className="measure-wide text-sm leading-relaxed text-red-600 dark:text-red-400">
            {errorMessage(change.error)}
          </p>
        </div>
      )}

      {/* ---------------- Create ---------------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New subscription"
        size="lg"
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
        {/* RULED FIELD GROUPS: what, how much, how often, who. Each group is
            opened by a hairline and named by a running head, so the form reads
            as four decisions rather than eleven inputs.

            Rules rather than surfaces, and deliberately: the dialog is already
            a surface, and `.well` — the only inset ground available — is the
            same fill `.input` uses, so a group of fields set on one would
            dissolve into its own container. A hairline divides WITHIN a
            surface, which is precisely the job here. */}
        <div className="space-y-5">
          <FieldGroup label="What you are billing for">
            <label className="label" htmlFor="sub-title">
              Title
            </label>
            <input
              id="sub-title"
              className="input"
              placeholder="Pro plan"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
            />

            <div className="mt-4">
              <label className="label" htmlFor="sub-desc">
                Description{' '}
                <span className="font-normal text-slate-500 dark:text-slate-400">
                  (optional)
                </span>
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
          </FieldGroup>

          <FieldGroup label="Amount">
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
          </FieldGroup>

          <FieldGroup label="Schedule">
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
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    days to pay
                  </span>
                </div>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup label="Customer">
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

            <label className="rule mt-4 flex items-start gap-2.5 pt-3 text-sm text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
                checked={autoSend}
                onChange={(e) => setAutoSend(e.target.checked)}
                disabled={!customerEmail.trim()}
              />
              <span>
                Email each invoice automatically
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                  {customerEmail.trim()
                    ? 'Sent to the customer as soon as each cycle is issued.'
                    : 'Add a customer email address to enable this.'}
                </span>
              </span>
            </label>
          </FieldGroup>

          {create.isError && (
            <p
              role="alert"
              className="measure-wide border-t border-red-600 pt-3 text-sm leading-relaxed text-red-600 dark:border-red-400 dark:text-red-400"
            >
              {errorMessage(create.error)}
            </p>
          )}
        </div>
      </Modal>

      {/* ---------------- Detail and billing history ---------------- */}
      <Modal
        open={Boolean(historyFor)}
        onClose={() => setHistoryFor(null)}
        title={historyFor?.title ?? ''}
        size="lg"
      >
        {historyFor && (
          <div>
            {historyFor.description && (
              <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {historyFor.description}
              </p>
            )}

            {historyFor.status === 'needs_attention' && (
              <div className="mt-4">
                <AttentionNote inset />
              </div>
            )}

            {/* THE SPINE. The terms of the schedule, ranged label against
                value — this is where the facts a card grid used to repeat
                eight times per screen now live, once, for the one
                subscription being read. */}
            <dl className="mt-5">
              <SpineRow label="Status">
                <StatusBadge status={historyFor.status} />
              </SpineRow>
              <SpineRow label="Amount per cycle">
                <span className="num">
                  {historyFor.currency} {formatAmount(historyFor.amount)}
                </span>
              </SpineRow>
              <SpineRow label="Cadence">
                every {cadence(historyFor.intervalCount, historyFor.intervalUnit)}
              </SpineRow>
              <SpineRow label="Customer">
                {historyFor.customerName ?? historyFor.customerEmail ?? '—'}
              </SpineRow>
              <SpineRow label={historyFor.status === 'canceled' ? 'Ended' : 'Next invoice'}>
                <span className="num">
                  {historyFor.status === 'canceled' ? '—' : formatDate(historyFor.nextRunAt)}
                </span>
              </SpineRow>
              <SpineRow label="Billed">
                <span className="num">
                  {historyFor.cyclesBilled}
                  {historyFor.totalCycles !== null && ` of ${historyFor.totalCycles}`} cycle
                  {historyFor.cyclesBilled === 1 ? '' : 's'}
                </span>
              </SpineRow>
              <SpineRow label="Payment terms">
                <span className="num">{historyFor.dueDays}</span> days to pay
              </SpineRow>
              <SpineRow label="Auto-send">
                {historyFor.autoSend ? 'On' : 'Off'}
              </SpineRow>
            </dl>

            <div className="mt-7">
              <span className="runhead">Billing history</span>

              {history.isLoading ? (
                <div className="mt-3 space-y-3" aria-busy="true">
                  <span className="sr-only" role="status">
                    Loading…
                  </span>
                  {/* Static, per the frequency boundary — a shimmer here would
                      loop every time a merchant opened a subscription. */}
                  <span className="ghost h-4 w-2/3" aria-hidden />
                  <span className="ghost h-4 w-1/2" aria-hidden />
                  <span className="ghost h-4 w-3/5" aria-hidden />
                </div>
              ) : history.isError ? (
                <div className="rule mt-3 pt-4">
                  <p className="measure text-sm leading-relaxed text-red-600 dark:text-red-400">
                    {errorMessage(history.error)}
                  </p>
                  <button
                    type="button"
                    className="btn-secondary mt-4"
                    onClick={() => history.refetch()}
                  >
                    Retry
                  </button>
                </div>
              ) : history.data && history.data.length === 0 ? (
                <div className="rule mt-3 pt-4">
                  <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    Nothing billed yet. The first invoice appears here once the next
                    cycle runs.
                  </p>
                </div>
              ) : (
                <>
                  {/* BELOW `sm` THE TABLE IS DROPPED, not scrolled sideways.
                      Four columns — cycle, invoice, amount, status — inside a
                      `size="lg"` dialog is 280px of room for content that wants
                      well over 400: the amount is `whitespace-nowrap` because a
                      figure must not break, and `.st` is `whitespace-nowrap`
                      because a status lozenge must not either, so the two of
                      them alone set a floor the dialog cannot meet. A merchant
                      reading their own billing history would have been dragging
                      it sideways inside a sheet that also scrolls vertically,
                      which is the worst gesture on a phone.

                      The stacked row carries every one of the four facts, which
                      is the test a mobile fallback has to pass — the invoice
                      number and its link lead, the cycle sits under it, and the
                      amount and status range right. */}
                  <ul className="mt-3 sm:hidden">
                    {history.data?.map((row) => (
                      <li
                        key={row.id}
                        className="rule flex items-start justify-between gap-3 py-2.5 first:border-t-0 first:pt-0"
                      >
                        <div className="min-w-0">
                          {row.token ? (
                            <a
                              href={checkoutUrl(row.token)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="link-ink text-sm font-medium"
                            >
                              {row.number}
                            </a>
                          ) : (
                            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                              {row.number}
                            </span>
                          )}
                          <p className="num mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            cycle {row.cycle_number}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="num text-sm whitespace-nowrap text-slate-700 dark:text-slate-300">
                            {row.currency} {formatAmount(row.total)}
                          </p>
                          <span className="mt-1 flex justify-end">
                            <Badge tone={row.status === 'paid' ? 'settled' : 'waiting'} dot>
                              {row.status}
                            </Badge>
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>

                  {/* From `sm` there is room for the real thing. The scroller
                      stays as the honest fallback for a very long invoice
                      number on a narrow tablet. */}
                  <div className="mt-3 hidden overflow-x-auto sm:block">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          <th className={HEAD}>Cycle</th>
                          <th className={HEAD}>Invoice</th>
                          <th className={`${HEAD} text-right`}>Amount</th>
                          <th className={HEAD}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.data?.map((row) => (
                          <tr key={row.id} className="align-baseline">
                            <td className="rule num py-2.5 pr-3 text-slate-500 dark:text-slate-400">
                              {row.cycle_number}
                            </td>
                            <td className="rule py-2.5 pr-3">
                              {row.token ? (
                                <a
                                  href={checkoutUrl(row.token)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="link-ink font-medium"
                                >
                                  {row.number}
                                </a>
                              ) : (
                                <span className="font-medium text-slate-700 dark:text-slate-300">
                                  {row.number}
                                </span>
                              )}
                            </td>
                            <td className="rule num py-2.5 pr-3 text-right whitespace-nowrap text-slate-700 dark:text-slate-300">
                              {row.currency} {formatAmount(row.total)}
                            </td>
                            <td className="rule py-2.5">
                              <Badge tone={row.status === 'paid' ? 'settled' : 'waiting'} dot>
                                {row.status}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/**
 * The header of the small in-modal ledger.
 *
 * Matched to `.ledger`'s own running head — 10.5px at 0.14em over a hairline —
 * rather than the 12px at 0.18em over a full-ink rule it carried before. Two
 * reasons, and neither is taste. A near-black 1px stroke is the outgoing
 * broadsheet's structural gesture, and on the dark ground its inverse reads as
 * a scar rather than as a rule; `--line` is the stroke the rest of the product
 * divides with. And uppercase at 0.18em tracking is what actually sets a
 * table's minimum width — the widest cell in this table used to be the word
 * "Amount", not any amount in it.
 */
const HEAD =
  'border-b border-[var(--line)] pb-1.5 pr-3 text-left text-[10.5px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400';

/**
 * The 44px box every icon control in this page's rows is drawn inside. Module
 * scope so the three buttons cannot drift apart, and `sm:` relaxes to 36 where
 * there is a pointer and vertical space is worth more — the same trade `.btn`
 * makes at the same breakpoint.
 */
const ICON_ACTION =
  'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors duration-100 disabled:opacity-40 sm:h-9 sm:w-9';

/**
 * Why billing stopped, and what resuming does.
 *
 * Amber because something is waiting on the merchant — but the word "needs
 * attention" is what carries the meaning, exactly as it does in the status
 * column, and the icon carries it a third time. No tint behind the block: a
 * per-notice fill would put a fifth colour on the page competing with the
 * status lozenges it is describing.
 *
 * TWO GROUNDS, BECAUSE IT LIVES ON TWO PLANES. On the page it is a `.surface` —
 * a raised object beside the ledger it qualifies. Inside the subscription
 * dialog, which is already floating, it takes `.well` instead: stacking a
 * raised surface on a floating one is the depth mistake that makes a design
 * read as amateur, and a notice inside a dialog is recessed into it, not
 * hovering above it.
 */
function AttentionNote({ names, inset = false }: { names?: string[]; inset?: boolean }) {
  const n = names?.length ?? 1;
  return (
    <div className={`${inset ? 'well' : 'surface'} p-4`}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          size={15}
          className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="min-w-0">
          <span className="runhead text-amber-600 dark:text-amber-400">
            Needs attention
          </span>
          <p className="measure-wide mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {n === 1 ? 'This fell' : `These ${n} fell`} too far behind schedule to catch up
            on {n === 1 ? 'its' : 'their'} own, so billing stopped rather than sending a
            burst of back-dated invoices. Resume {n === 1 ? 'it' : 'them'} to restart on a
            clean schedule — the missed cycles are not billed.
          </p>
          {names && names.length > 0 && (
            <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">
              {names.join(' · ')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** A named group of fields, opened by a hairline. */
function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="rule pt-4">
      <span className="runhead">{label}</span>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** One row of the spine: a narrow label against a wide value, on a hairline. */
function SpineRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="spine-row">
      <dt className="spine-label">{label}</dt>
      <dd className="spine-value">{children}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: Subscription['status'] }) {
  // Semantic tone names rather than hues, and the same four inks the rest of
  // the product uses: billing is healthy, billing is waiting on you, billing
  // failed, or it is over.
  const tone =
    status === 'active'
      ? 'settled'
      : status === 'paused'
        ? 'waiting'
        : status === 'needs_attention'
          ? 'failed'
          : 'neutral';
  return (
    <Badge tone={tone} dot>
      {status === 'needs_attention' ? 'needs attention' : status}
    </Badge>
  );
}

/** Sort order for the status column: most actionable first. */
const STATUS_RANK: Record<Subscription['status'], number> = {
  needs_attention: 0,
  active: 1,
  paused: 2,
  canceled: 3,
};

/**
 * Approximate days in one interval unit — used ONLY to order the cadence
 * column, never to compute a date. A month is not 30 days and this arithmetic
 * would be wrong if it were billing anyone; sorting is the one job where "a
 * year is longer than a month" is all the precision needed.
 */
const UNIT_DAYS: Record<IntervalUnit, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

function cadence(count: number, unit: string): string {
  return count === 1 ? unit : `${count} ${unit}s`;
}
