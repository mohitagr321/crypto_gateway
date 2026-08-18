import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Ban,
  ExternalLink,
  Mail,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  checkoutUrl,
  createInvoice,
  errorMessage,
  getInvoice,
  getRates,
  listInvoices,
  sendInvoice,
  voidInvoice,
} from '@/lib/api';
import { formatAmount, formatDate } from '@/lib/format';
import type { Invoice } from '@/types';
import PageHeader from '@/components/PageHeader';
import CopyButton from '@/components/CopyButton';
import Modal from '@/components/Modal';
import Spinner from '@/components/Spinner';
import Badge from '@/components/Badge';
import StatCard from '@/components/StatCard';
import Section from '@/components/Section';
import DataTable, { type Column } from '@/components/DataTable';

/**
 * Invoices — line items in, a payable link out.
 *
 * An invoice is denominated in the merchant's own currency; the customer picks
 * a coin at checkout and the conversion happens when they pay. So this page
 * never shows a crypto amount: quoting one here would be a number that is
 * already out of date by the time anyone reads it.
 *
 * ASSEMBLED FROM SURFACES, not from ruled bands. The outgoing version printed
 * everything straight onto the page and divided it with hairlines, which gave
 * the eye nothing to land on: the outstanding figures, the ledger and the
 * last action's outcome were one continuous column of type at one weight. Each
 * is now its own lit surface, so "what am I owed" and "which invoice" are two
 * objects rather than two paragraphs. No hero, no entrance animation, no
 * count-up — a merchant opens this screen to read a number, and the number is
 * simply there when they arrive.
 *
 * OUTSTANDING IS TOTALLED PER CURRENCY AND NEVER CONVERTED. This is the same
 * invariant BalanceStrip holds for (network, asset): an invoice is a fiat
 * document, EUR 400 and USD 400 are not 800 of anything, and there is no rate
 * on this page to make them comparable. One column per currency, always.
 */

interface DraftItem {
  description: string;
  quantity: string;
  unitPrice: string;
}

const EMPTY_ITEM: DraftItem = { description: '', quantity: '1', unitPrice: '' };

export default function Invoices() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<string | null>(null);

  const [currency, setCurrency] = useState('USD');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ ...EMPTY_ITEM }]);

  const invoices = useQuery({ queryKey: ['invoices'], queryFn: () => listInvoices() });
  // Only for the currency list — the panel offers exactly what the gateway can
  // price in, rather than a hardcoded list that drifts from the server's.
  const rates = useQuery({
    queryKey: ['rates'],
    queryFn: getRates,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ['invoice', detailFor],
    queryFn: () => getInvoice(detailFor!),
    enabled: Boolean(detailFor),
  });

  // Mirrors the server's arithmetic so the merchant sees the total before
  // submitting. The server recomputes it — this is a preview, never the source.
  const totals = useMemo(() => {
    const sum = items.reduce((acc, i) => {
      const q = Number(i.quantity || '1');
      const p = Number(i.unitPrice || '0');
      return acc + (Number.isFinite(q) && Number.isFinite(p) ? q * p : 0);
    }, 0);
    const tax = Number(taxAmount || '0');
    return {
      subtotal: sum,
      tax: Number.isFinite(tax) ? tax : 0,
      total: sum + (Number.isFinite(tax) ? tax : 0),
    };
  }, [items, taxAmount]);

  /**
   * What is still owed, grouped by the currency it is owed in. `open` is the
   * only status that carries a balance: paid is settled, void is cancelled and
   * a draft has never been issued to anyone.
   *
   * Accumulated as SCALED INTEGERS, never as floats — see `toScaled`.
   */
  const ledger = useMemo(() => {
    const list = invoices.data ?? [];
    const by = new Map<string, { currency: string; total: bigint; open: number; overdue: number }>();
    let open = 0;
    let overdue = 0;

    for (const inv of list) {
      if (inv.status !== 'open') continue;
      open += 1;
      if (inv.overdue) overdue += 1;

      const row =
        by.get(inv.currency) ?? { currency: inv.currency, total: 0n, open: 0, overdue: 0 };
      row.total += toScaled(inv.total);
      row.open += 1;
      if (inv.overdue) row.overdue += 1;
      by.set(inv.currency, row);
    }

    return {
      count: list.length,
      open,
      overdue,
      // Largest balance first: the currency you are owed most in is the one
      // worth reading first.
      byCurrency: [...by.values()].sort((a, b) => (a.total === b.total ? 0 : a.total > b.total ? -1 : 1)),
    };
  }, [invoices.data]);

  const reset = () => {
    setCustomerName('');
    setCustomerEmail('');
    setDueDate('');
    setNotes('');
    setTaxAmount('');
    setItems([{ ...EMPTY_ITEM }]);
  };

  const create = useMutation({
    mutationFn: () =>
      createInvoice({
        currency,
        customerName: customerName.trim() || undefined,
        customerEmail: customerEmail.trim() || undefined,
        dueDate: dueDate || undefined,
        notes: notes.trim() || undefined,
        taxAmount: taxAmount.trim() || undefined,
        items: items
          .filter((i) => i.description.trim() && i.unitPrice.trim())
          .map((i) => ({
            description: i.description.trim(),
            quantity: i.quantity.trim() || '1',
            unitPrice: i.unitPrice.trim(),
          })),
      }),
    onSuccess: () => {
      setCreateOpen(false);
      reset();
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });

  const send = useMutation({
    mutationFn: (id: string) => sendInvoice(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });

  const kill = useMutation({
    mutationFn: (id: string) => voidInvoice(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice'] });
    },
  });

  const canSubmit =
    items.some((i) => i.description.trim() && i.unitPrice.trim()) && totals.total > 0;

  /**
   * The per-row controls. A plain function rather than a component so it closes
   * over the mutations without prop plumbing — and so React never sees a new
   * component type between renders.
   *
   * The wrapper stops the click reaching the row: these buttons act on the
   * invoice, they do not open it. Enter on a button is safe already — the row's
   * key handler only fires when the row itself is the target.
   *
   * EVERY CONTROL HERE IS 44px UNTIL `sm`. They were 28px squares — a `p-1.5`
   * around a 14px glyph — which on a phone is a target you hit by luck, and one
   * of the three voids an invoice. The glyph stays 14px because the row's
   * density is right; what grows is the box around it, exactly as `.btn` does
   * at the same breakpoint and for the same reason.
   */
  const iconAction =
    'grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors duration-100 disabled:opacity-40 sm:h-9 sm:w-9';

  const rowActions = (inv: Invoice, justify: 'justify-start' | 'justify-end') => (
    <div
      className={`flex items-center ${justify}`}
      onClick={(e) => e.stopPropagation()}
    >
      {inv.token && inv.status !== 'void' && (
        <>
          <CopyButton value={checkoutUrl(inv.token)} size={14} />
          <a
            href={checkoutUrl(inv.token)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${iconAction} hover:text-brand-600 dark:hover:text-brand-400`}
            title="Open pay page"
            aria-label={`Open pay page for ${inv.number}`}
          >
            <ExternalLink size={14} />
          </a>
        </>
      )}
      {inv.status === 'open' && inv.customerEmail && (
        <button
          type="button"
          className={`${iconAction} hover:bg-[var(--hover)] hover:text-slate-700 dark:hover:text-slate-200`}
          onClick={() => send.mutate(inv.id)}
          disabled={send.isPending}
          title={`Email to ${inv.customerEmail}`}
          aria-label={`Email ${inv.number} to ${inv.customerEmail}`}
        >
          <Mail size={14} />
        </button>
      )}
      {inv.status !== 'paid' && inv.status !== 'void' && (
        <button
          type="button"
          className={`${iconAction} hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400`}
          onClick={() => kill.mutate(inv.id)}
          disabled={kill.isPending}
          title="Void this invoice"
          aria-label={`Void ${inv.number}`}
        >
          <Ban size={14} />
        </button>
      )}
    </div>
  );

  const columns: Column<Invoice>[] = [
    {
      key: 'number',
      header: 'Invoice',
      sortValue: (inv) => inv.number,
      render: (inv) => (
        <span className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
          {inv.number}
          {inv.subscriptionId && (
            <span className="num ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              cycle {inv.cycleNumber}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      sortValue: (inv) => inv.customerName ?? '',
      render: (inv) =>
        inv.customerName ?? <span className="text-slate-500 dark:text-slate-400">—</span>,
      className: 'text-slate-600 dark:text-slate-400',
    },
    {
      // Money: ranged right on tabular figures so the decimals stack — which
      // is why this is `formatAmount` and not `trim`. Trimming trailing zeros
      // gives 1240.5 above 9.5 above 420, and a right-ranged column of figures
      // whose decimal points do not line up is worse than no alignment at all.
      // The currency travels WITH the figure: an invoice total with no currency
      // on it is a number, not an amount.
      key: 'total',
      header: 'Amount',
      numeric: true,
      sortValue: (inv) => Number(inv.total) || 0,
      render: (inv) => (
        <span className="whitespace-nowrap font-medium text-slate-900 dark:text-slate-100">
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {inv.currency}
          </span>{' '}
          {formatAmount(inv.total)}
        </span>
      ),
    },
    {
      key: 'due',
      header: 'Due',
      // Sorted on the RAW `YYYY-MM-DD`, which already sorts lexicographically,
      // and displayed formatted. Sorting the rendered label would file March
      // before May before November.
      sortValue: (inv) => inv.dueDate ?? '',
      render: (inv) =>
        inv.dueDate ? (
          <span
            className={`num whitespace-nowrap ${
              inv.overdue && inv.status === 'open'
                ? 'font-medium text-red-600 dark:text-red-400'
                : ''
            }`}
          >
            {formatDueDate(inv.dueDate)}
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">—</span>
        ),
    },
    {
      // Sortable on a real order — overdue, open, draft, paid, void — rather
      // than alphabetically on the rendered word, which would file "overdue"
      // between "open" and "paid" and mean nothing.
      key: 'status',
      header: 'Status',
      sortValue: (inv) => statusRank(inv),
      render: (inv) => <StatusBadge invoice={inv} />,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (inv) => rowActions(inv, 'justify-end'),
    },
  ];

  /** Six columns is too many for a phone; below `md` each invoice stacks. */
  const renderMobile = (inv: Invoice) => (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-medium text-slate-900 dark:text-slate-100">
          {inv.number}
          {inv.subscriptionId && (
            <span className="num ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              cycle {inv.cycleNumber}
            </span>
          )}
        </span>
        <span className="num shrink-0 font-medium text-slate-900 dark:text-slate-100">
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {inv.currency}
          </span>{' '}
          {formatAmount(inv.total)}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3">
        <span className="truncate text-sm text-slate-500 dark:text-slate-400">
          {inv.customerName ?? 'No customer'}
          {inv.dueDate && (
            <span className={inv.overdue && inv.status === 'open' ? 'text-red-600 dark:text-red-400' : ''}>
              {' '}
              · {inv.overdue && inv.status === 'open' ? 'was due' : 'due'}{' '}
              {formatDueDate(inv.dueDate)}
            </span>
          )}
        </span>
        <StatusBadge invoice={inv} />
      </div>
      {/* Pulled left so the first glyph ranges with the text above it rather
          than with the 44px box drawn around it. */}
      <div className="-ml-3 mt-1">{rowActions(inv, 'justify-start')}</div>
    </div>
  );

  return (
    <>
      <PageHeader
        eyebrow="Billing"
        title="Invoices"
        description="Bill in your own currency. Your customer pays in a stablecoin — the conversion happens when they pay."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New invoice
          </button>
        }
        meta={
          invoices.data
            ? `${ledger.count} ${ledger.count === 1 ? 'invoice' : 'invoices'} · ${
                ledger.open
              } open${ledger.overdue > 0 ? ` · ${ledger.overdue} overdue` : ''}`
            : undefined
        }
      />

      {/* THE OUTSTANDING STRIP. One TILE per currency — never a single
          converted total. Rendered only when something is actually owed, so an
          account with nothing open does not pay a row of screen for four
          zeroes.

          `auto-fit` + `minmax` rather than `sm:grid-cols-2 lg:grid-cols-4`: a
          merchant billing in one currency got a quarter-width tile with three
          empty columns beside it, and a merchant billing in five got a widow on
          the second row. The track also refuses to squeeze a tile below the
          width its figure needs, which is what lets `StatCard`'s `break-words`
          work — a truncated balance is silent data loss. */}
      {ledger.byCurrency.length > 0 && (
        <section className="mb-4" aria-label="Outstanding">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
            {ledger.byCurrency.map((row) => (
              <StatCard
                key={row.currency}
                label={`Outstanding · ${row.currency}`}
                value={formatAmount(fromScaled(row.total))}
                tone={row.overdue > 0 ? 'red' : 'brand'}
                icon={row.overdue > 0 ? AlertTriangle : undefined}
                sub={
                  <>
                    {row.open} open
                    {row.overdue > 0 && (
                      <span className="text-red-600 dark:text-red-400">
                        {' '}
                        · {row.overdue} overdue
                      </span>
                    )}
                  </>
                }
              />
            ))}
          </div>
          <p className="measure-wide mt-3 px-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Totalled per currency and never converted — an invoice is a fiat document,
            and there is no rate on this page to make two currencies comparable.
          </p>
        </section>
      )}

      {/* The ledger, on its own titled surface. `flush` because a table ranges
          to the edges of the surface it sits on — padding here would inset the
          rows from the rules that divide them. */}
      <Section flush title="All invoices">
        <DataTable
          columns={columns}
          rows={invoices.data ?? []}
          rowKey={(inv) => inv.id}
          loading={invoices.isLoading}
          error={invoices.isError ? errorMessage(invoices.error) : null}
          onRetry={() => invoices.refetch()}
          onRowClick={(inv) => setDetailFor(inv.id)}
          renderMobile={renderMobile}
          label="Invoices"
          // Unpaginated, so it can run long — the height cap is what makes the
          // running heads stay put through a thousand rows. `dvh`, never `vh`:
          // on mobile Safari `vh` measures the viewport WITHOUT the collapsing
          // toolbar, so a 70vh box is taller than 70% of what you can see.
          maxHeight="70dvh"
          skeletonRows={8}
          emptyLabel="No invoices yet."
          emptyHint="Add line items, set a due date, and email it. Your customer gets a page they can pay in any coin you accept."
          emptyAction={
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Create your first invoice
            </button>
          }
        />
      </Section>

      {/* The outcome of the last row action, on its own surface rather than
          under a hairline. A result that matters enough to interrupt the page
          is an object on it, not a paragraph appended to the ledger. */}
      {(send.isSuccess || send.isError || kill.isError) && (
        <div className="surface mt-4 p-4" role="status" aria-live="polite">
          {send.isSuccess && (
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {send.data.sent
                ? `Emailed to ${send.data.to}.`
                : `Rendered for ${send.data.to} — this gateway has no mail server configured, so it went to the server log instead.`}
            </p>
          )}
          {send.isError && (
            <p className="measure-wide text-sm leading-relaxed text-red-600 dark:text-red-400">
              {errorMessage(send.error)}
            </p>
          )}
          {kill.isError && (
            <p className="measure-wide text-sm leading-relaxed text-red-600 dark:text-red-400">
              {errorMessage(kill.error)}
            </p>
          )}
        </div>
      )}

      {/* ---------------- Create ---------------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New invoice"
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
              disabled={create.isPending || !canSubmit}
            >
              {create.isPending ? <Spinner size={16} /> : 'Create and issue'}
            </button>
          </>
        }
      >
        {/* RULED FIELD GROUPS, and they stay ruled — this is the one place in
            the redesign where a hairline is still the right structural device.
            Surfaces carry structure between PLANES, and the dialog is already a
            surface; nesting five more inside it would stack elevation on
            elevation, and a `.well` behind a group of fields is the same fill
            `.input` uses, so the fields would disappear into their own
            container. A rule divides WITHIN a surface, which is exactly the job
            here: the eye finds "line items" without reading every label on the
            way there. */}
        <div className="space-y-5">
          <FieldGroup label="Document">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="inv-currency">
                  Currency
                </label>
                <select
                  id="inv-currency"
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
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  What you bill in. Your customer still pays in crypto.
                </p>
              </div>
              <div>
                <label className="label" htmlFor="inv-due">
                  Due date{' '}
                  <span className="font-normal text-slate-500 dark:text-slate-400">
                    (optional)
                  </span>
                </label>
                <input
                  id="inv-due"
                  type="date"
                  className="input"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>
          </FieldGroup>

          <FieldGroup label="Customer">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="inv-cust">
                  Customer name
                </label>
                <input
                  id="inv-cust"
                  className="input"
                  placeholder="Priya Raman"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  maxLength={200}
                />
              </div>
              <div>
                <label className="label" htmlFor="inv-email">
                  Customer email
                </label>
                <input
                  id="inv-email"
                  type="email"
                  className="input"
                  placeholder="priya@example.com"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                />
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Needed to email the invoice. You can always copy the link instead.
                </p>
              </div>
            </div>
          </FieldGroup>

          {/* ---- Line items, set as a ledger you type into ----

              THE ROW STACKS BELOW `sm`, and this is the defect that made the
              whole dialog unusable on a phone rather than merely tight. Inside
              a `size="lg"` modal at 360px the content box is 280px wide; the
              qty field (64), the price field (112), the remove control and
              three gaps took 228 of it, leaving 52px for the DESCRIPTION —
              of which `.input`'s own horizontal padding ate 28. A merchant was
              typing a line item three characters at a time.

              `flex-wrap` + `w-full` on the description is what fixes it, and it
              is deliberately not a second layout: the description claims a full
              line, qty and price fall onto the next one with price taking the
              slack, and at `sm` a single `flex-nowrap` returns all four to one
              row. The header above has always been `hidden sm:flex` — it was
              written for a stacked mobile row that was never built, and this is
              that row. */}
          <FieldGroup label="Line items">
            <div className="hidden items-end gap-2 pb-1.5 sm:flex">
              <span className="runhead flex-1">Description</span>
              <span className="runhead w-16">Qty</span>
              <span className="runhead w-28">Price</span>
              <span className="w-9 shrink-0" aria-hidden />
            </div>
            <div>
              {items.map((item, idx) => (
                <div
                  key={idx}
                  className="rule flex flex-wrap items-center gap-2 py-2.5 first:border-t-0 first:pt-0 sm:flex-nowrap sm:py-2"
                >
                  <input
                    className="input w-full sm:w-auto sm:flex-1"
                    placeholder="Description"
                    value={item.description}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === idx ? { ...it, description: e.target.value } : it,
                        ),
                      )
                    }
                    maxLength={500}
                    aria-label={`Line ${idx + 1} description`}
                  />
                  <input
                    className="input num w-16"
                    inputMode="decimal"
                    placeholder="Qty"
                    value={item.quantity}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === idx ? { ...it, quantity: e.target.value } : it,
                        ),
                      )
                    }
                    aria-label={`Line ${idx + 1} quantity`}
                  />
                  {/* Price takes the slack on the stacked line and returns to
                      its fixed column at `sm`, so the four fields still range
                      under their running heads on a desktop. */}
                  <input
                    className="input num flex-1 sm:w-28 sm:flex-none"
                    inputMode="decimal"
                    placeholder="Price"
                    value={item.unitPrice}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((it, i) =>
                          i === idx ? { ...it, unitPrice: e.target.value } : it,
                        ),
                      )
                    }
                    aria-label={`Line ${idx + 1} unit price`}
                  />
                  <button
                    type="button"
                    className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 transition-colors duration-100 hover:text-red-600 disabled:opacity-30 sm:h-9 sm:w-9 dark:hover:text-red-400"
                    onClick={() =>
                      setItems((prev) => prev.filter((_, i) => i !== idx))
                    }
                    disabled={items.length === 1}
                    aria-label={`Remove line ${idx + 1}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            {/* A real control rather than a text link: "+ Add line" was a 20px
                target, and this is the button that makes the form longer. */}
            <button
              type="button"
              className="btn-secondary mt-3"
              onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
            >
              <Plus size={14} /> Add line
            </button>
          </FieldGroup>

          <FieldGroup label="Total">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="inv-tax">
                  Tax{' '}
                  <span className="font-normal text-slate-500 dark:text-slate-400">
                    (optional)
                  </span>
                </label>
                <input
                  id="inv-tax"
                  className="input num"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={taxAmount}
                  onChange={(e) => setTaxAmount(e.target.value)}
                />
              </div>
              {/* The running total, set as a ledger: hairlines between the
                  lines and an ink rule above the total. */}
              <dl className="flex flex-col justify-end">
                <div className="rule flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-sm text-slate-500 dark:text-slate-400">Subtotal</dt>
                  <dd className="num text-sm text-slate-700 dark:text-slate-300">
                    {totals.subtotal.toFixed(2)}
                  </dd>
                </div>
                {totals.tax > 0 && (
                  <div className="rule flex items-baseline justify-between gap-4 py-2">
                    <dt className="text-sm text-slate-500 dark:text-slate-400">Tax</dt>
                    <dd className="num text-sm text-slate-700 dark:text-slate-300">
                      {totals.tax.toFixed(2)}
                    </dd>
                  </div>
                )}
                <div className="rule-strong flex items-baseline justify-between gap-4 pt-2.5">
                  <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Total
                  </dt>
                  <dd className="num text-base font-semibold whitespace-nowrap text-slate-900 dark:text-slate-100">
                    {currency} {totals.total.toFixed(2)}
                  </dd>
                </div>
              </dl>
            </div>
          </FieldGroup>

          <FieldGroup label="Notes — optional">
            <input
              id="inv-notes"
              aria-label="Notes"
              className="input"
              placeholder="Net 14. Thanks!"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
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

      {/* ---------------- Detail ---------------- */}
      <Modal
        open={Boolean(detailFor)}
        onClose={() => setDetailFor(null)}
        title={detail.data?.number ?? 'Invoice'}
      >
        {detail.isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <span className="sr-only" role="status">
              Loading…
            </span>
            {/* Static, per the frequency boundary: a shimmer here would loop on
                a surface a merchant opens dozens of times a day. */}
            <span className="ghost h-4 w-1/3" aria-hidden />
            <span className="ghost h-4 w-3/4" aria-hidden />
            <span className="ghost h-4 w-2/3" aria-hidden />
            <span className="ghost h-4 w-1/2" aria-hidden />
          </div>
        ) : detail.data ? (
          <div>
            <div className="rule-b flex items-start justify-between gap-4 pb-3">
              <div className="min-w-0">
                <span className="runhead">Billed to</span>
                <p className="mt-1 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {detail.data.customerName ?? 'No customer name'}
                </p>
                {detail.data.customerEmail && (
                  <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                    {detail.data.customerEmail}
                  </p>
                )}
              </div>
              <StatusBadge invoice={detail.data} />
            </div>

            {/* THE LINE ITEMS, inside a dialog that is 280px wide on a phone.
                Two things keep them there. The scroller is the honest fallback
                for a table that cannot be made narrower — without it a long
                description pushed the whole dialog sideways and the close
                control with it. `break-words` is what usually means the
                scroller never has to fire: the only thing that can set a
                minimum width on this table now is a single unbreakable word,
                and the amounts stay `whitespace-nowrap` because a figure that
                wraps mid-number is worse than one that scrolls. */}
            <div className="mt-5">
              <span className="runhead">What this covers</span>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {detail.data.items.map((i) => (
                      <tr key={i.id} className="align-baseline">
                        <td className="rule break-words py-2.5 pr-3 text-slate-700 dark:text-slate-300">
                          {i.description}
                          {Number(i.quantity) !== 1 && (
                            <span className="num ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                              × {trim(i.quantity)}
                            </span>
                          )}
                        </td>
                        <td className="rule num py-2.5 text-right whitespace-nowrap text-slate-700 dark:text-slate-300">
                          {formatAmount(i.amount)}
                        </td>
                      </tr>
                    ))}
                    {Number(detail.data.taxAmount) > 0 && (
                      <tr>
                        <td className="rule py-2.5 pr-3 text-slate-500 dark:text-slate-400">
                          Tax
                        </td>
                        <td className="rule num py-2.5 text-right text-slate-500 dark:text-slate-400">
                          {formatAmount(detail.data.taxAmount)}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td className="rule-strong py-2.5 pr-3 font-semibold text-slate-900 dark:text-slate-100">
                        Total
                      </td>
                      <td className="rule-strong num py-2.5 text-right font-semibold whitespace-nowrap text-slate-900 dark:text-slate-100">
                        {money(detail.data.currency, detail.data.total)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {detail.data.notes && (
              <p className="rule measure mt-5 pt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {detail.data.notes}
              </p>
            )}

            {/* An INSET surface, not a ruled band: a URL you are meant to lift
                out and send is a code block, and `.well` is the primitive for
                one. It also gives the copy control a ground to sit on instead
                of floating at the end of a hairline. */}
            {detail.data.token && detail.data.status !== 'void' && (
              <div className="well mt-5 p-3">
                <span className="runhead">Pay link</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600 dark:text-slate-300">
                    {checkoutUrl(detail.data.token)}
                  </code>
                  <CopyButton value={checkoutUrl(detail.data.token)} />
                </div>
              </div>
            )}

            <dl className="mt-5">
              <SpineRow label="Issued">
                {formatDate(detail.data.issuedAt ?? detail.data.createdAt)}
              </SpineRow>
              {detail.data.sentAt && (
                <SpineRow label="Sent">{formatDate(detail.data.sentAt)}</SpineRow>
              )}
              {detail.data.paidAt && (
                <SpineRow label="Paid">{formatDate(detail.data.paidAt)}</SpineRow>
              )}
            </dl>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

/**
 * A named group of fields, opened by a hairline. The first group keeps its rule
 * — it is what separates the form from the modal's title.
 */
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

function StatusBadge({ invoice }: { invoice: Invoice }) {
  // Overdue is shown in place of "open" because it is the more actionable fact —
  // but it is a rendering of `open` + a date, never a status of its own.
  if (invoice.status === 'open' && invoice.overdue) {
    return <Badge tone="failed" dot>overdue</Badge>;
  }
  // Semantic tone names, not hues: `open` is amber because the money is still
  // owed, `paid` is emerald because it arrived, and a draft or a void is
  // archival slate.
  const tone =
    invoice.status === 'paid'
      ? 'settled'
      : invoice.status === 'open'
        ? 'waiting'
        : 'neutral';
  return (
    <Badge tone={tone} dot>
      {invoice.status}
    </Badge>
  );
}

/** Sort order for the status column: most actionable first. */
function statusRank(invoice: Invoice): number {
  if (invoice.status === 'open' && invoice.overdue) return 0;
  const rank: Record<Invoice['status'], number> = { open: 1, draft: 2, paid: 3, void: 4 };
  return rank[invoice.status] ?? 5;
}

function money(currency: string, value: string): string {
  return `${currency} ${formatAmount(value)}`;
}

/**
 * A due date, in the same shape `formatDateShort` gives every other date in the
 * panel — so Invoices and Subscriptions, which sit next to each other in the
 * nav, do not disagree about what a date looks like.
 *
 * It does NOT go through `formatDateShort`, and the reason is a bug rather than
 * a preference. `due_date` is a DATE, not a timestamp: it has no time and no
 * zone. `new Date('2026-07-14')` parses it as UTC midnight, and rendering that
 * in a local zone west of UTC prints the 13th — a merchant in New York would be
 * told an invoice is due a day earlier than it is, and an invoice due today
 * would read as overdue. Building the date in UTC and formatting it in UTC
 * keeps the day the server said it was.
 */
function formatDueDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
}

/**
 * MONEY IS NEVER SUMMED AS A FLOAT.
 *
 * The outstanding figures are the only totals on this page the server does not
 * hand us ready-made, and `0.1 + 0.2 === 0.30000000000000004` is not a curiosity
 * on a billing screen — it is a merchant reading that they are owed
 * 1,240.0000000000002. Totals are accumulated as integers scaled to the
 * column's own NUMERIC(38,18) precision and only formatted at the very end.
 */
const SCALE = 18;

function toScaled(v: string): bigint {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(v.trim());
  // An unparseable amount contributes nothing rather than NaN-poisoning the
  // whole column.
  if (!m) return 0n;
  const [, sign, whole, frac = ''] = m;
  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const n = BigInt(`${whole || '0'}${padded}`);
  return sign === '-' ? -n : n;
}

/**
 * A scaled integer back to a plain decimal string — EXACT, never rounded. The
 * presentation (grouping, minimum two decimals) is left to `formatAmount`, the
 * one money formatter the panel uses, so a total reads identically wherever it
 * appears.
 */
function fromScaled(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const unit = 10n ** BigInt(SCALE);
  const whole = (abs / unit).toString();
  const frac = (abs % unit)
    .toString()
    .padStart(SCALE, '0')
    .replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Drop trailing zeros from a NUMERIC(38,18) string. For QUANTITIES only — a
 * quantity of four is "× 4", not "× 4.00". Money goes through `formatAmount`,
 * which keeps two decimals so a column of figures stays aligned.
 */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
}
