import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  ExternalLink,
  FileText,
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
import { formatDate } from '@/lib/format';
import type { Invoice } from '@/types';
import PageHeader from '@/components/PageHeader';
import CopyButton from '@/components/CopyButton';
import Modal from '@/components/Modal';
import Spinner, { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import Badge from '@/components/Badge';

/**
 * Invoices — line items in, a payable link out.
 *
 * An invoice is denominated in the merchant's own currency; the customer picks
 * a coin at checkout and the conversion happens when they pay. So this page
 * never shows a crypto amount: quoting one here would be a number that is
 * already out of date by the time anyone reads it.
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

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Bill in your own currency. Your customer pays in a stablecoin — the conversion happens when they pay."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New invoice
          </button>
        }
      />

      {invoices.isLoading ? (
        <LoadingPanel />
      ) : invoices.isError ? (
        <ErrorState
          message={errorMessage(invoices.error)}
          onRetry={() => invoices.refetch()}
        />
      ) : invoices.data && invoices.data.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <FileText size={34} className="text-slate-300 dark:text-slate-700" />
          <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            No invoices yet
          </h3>
          <p className="mt-1.5 max-w-sm text-sm text-slate-500">
            Add line items, set a due date, and email it. Your customer gets a page
            they can pay in any coin you accept.
          </p>
          <button className="btn-primary mt-6" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Create your first invoice
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800/50">
                <tr>
                  <th className="px-4 py-3 font-medium">Invoice</th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 text-right font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Due</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {invoices.data?.map((inv) => (
                  <tr
                    key={inv.id}
                    className="cursor-pointer transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    onClick={() => setDetailFor(inv.id)}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                      {inv.number}
                      {inv.subscriptionId && (
                        <span className="ml-2 text-xs font-normal text-slate-400">
                          cycle {inv.cycleNumber}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                      {inv.customerName ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="num font-medium text-slate-900 dark:text-slate-100">
                        {money(inv.currency, inv.total)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                      {inv.dueDate ?? <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge invoice={inv} />
                    </td>
                    <td className="px-4 py-3">
                      <div
                        className="flex justify-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {inv.token && inv.status !== 'void' && (
                          <>
                            <CopyButton value={checkoutUrl(inv.token)} />
                            <a
                              href={checkoutUrl(inv.token)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded p-1.5 text-slate-400 transition hover:text-brand-600"
                              title="Open pay page"
                            >
                              <ExternalLink size={14} />
                            </a>
                          </>
                        )}
                        {inv.status === 'open' && inv.customerEmail && (
                          <button
                            className="rounded p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
                            onClick={() => send.mutate(inv.id)}
                            disabled={send.isPending}
                            title={`Email to ${inv.customerEmail}`}
                          >
                            <Mail size={14} />
                          </button>
                        )}
                        {inv.status !== 'paid' && inv.status !== 'void' && (
                          <button
                            className="rounded p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                            onClick={() => kill.mutate(inv.id)}
                            disabled={kill.isPending}
                            title="Void this invoice"
                          >
                            <Ban size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {send.isSuccess && (
        <p className="mt-3 text-sm text-slate-500">
          {send.data.sent
            ? `Emailed to ${send.data.to}.`
            : `Rendered for ${send.data.to} — this gateway has no mail server configured, so it went to the server log instead.`}
        </p>
      )}
      {send.isError && (
        <p className="mt-3 text-sm text-red-600">{errorMessage(send.error)}</p>
      )}
      {kill.isError && (
        <p className="mt-3 text-sm text-red-600">{errorMessage(kill.error)}</p>
      )}

      {/* ---------------- Create ---------------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New invoice"
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
        <div className="space-y-4">
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
              <p className="mt-1 text-xs text-slate-500">
                What you bill in. Your customer still pays in crypto.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="inv-due">
                Due date <span className="font-normal text-slate-400">(optional)</span>
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
              <p className="mt-1 text-xs text-slate-500">
                Needed to email the invoice. You can always copy the link instead.
              </p>
            </div>
          </div>

          {/* ---- Line items ---- */}
          <div>
            <span className="label">Line items</span>
            <div className="mt-1 space-y-2">
              {items.map((item, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <input
                    className="input flex-1"
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
                    className="input num w-20"
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
                  <input
                    className="input num w-28"
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
                    className="mt-2 shrink-0 text-slate-400 transition hover:text-red-600 disabled:opacity-30"
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
            <button
              type="button"
              className="mt-2 text-sm font-medium text-brand-600 transition hover:text-brand-700"
              onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
            >
              + Add line
            </button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="inv-tax">
                Tax <span className="font-normal text-slate-400">(optional)</span>
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
            <div className="flex flex-col justify-end">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Subtotal</span>
                  <span className="num">{totals.subtotal.toFixed(2)}</span>
                </div>
                {totals.tax > 0 && (
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Tax</span>
                    <span className="num">{totals.tax.toFixed(2)}</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 text-sm font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
                  <span>Total</span>
                  <span className="num">
                    {currency} {totals.total.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="inv-notes">
              Notes <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="inv-notes"
              className="input"
              placeholder="Net 14. Thanks!"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
          </div>

          {create.isError && (
            <p className="text-sm text-red-600">{errorMessage(create.error)}</p>
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
          <LoadingPanel />
        ) : detail.data ? (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="text-sm">
                <p className="font-medium text-slate-900 dark:text-slate-100">
                  {detail.data.customerName ?? 'No customer name'}
                </p>
                {detail.data.customerEmail && (
                  <p className="text-slate-500">{detail.data.customerEmail}</p>
                )}
              </div>
              <StatusBadge invoice={detail.data} />
            </div>

            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {detail.data.items.map((i) => (
                  <tr key={i.id}>
                    <td className="py-2 text-slate-700 dark:text-slate-300">
                      {i.description}
                      {Number(i.quantity) !== 1 && (
                        <span className="ml-1.5 text-xs text-slate-400">
                          × {trim(i.quantity)}
                        </span>
                      )}
                    </td>
                    <td className="num py-2 text-right text-slate-700 dark:text-slate-300">
                      {trim(i.amount)}
                    </td>
                  </tr>
                ))}
                {Number(detail.data.taxAmount) > 0 && (
                  <tr>
                    <td className="py-2 text-slate-500">Tax</td>
                    <td className="num py-2 text-right text-slate-500">
                      {trim(detail.data.taxAmount)}
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="py-2 font-semibold text-slate-900 dark:text-slate-100">
                    Total
                  </td>
                  <td className="num py-2 text-right font-semibold text-slate-900 dark:text-slate-100">
                    {money(detail.data.currency, detail.data.total)}
                  </td>
                </tr>
              </tbody>
            </table>

            {detail.data.notes && (
              <p className="rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-400">
                {detail.data.notes}
              </p>
            )}

            {detail.data.token && detail.data.status !== 'void' && (
              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/60">
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600 dark:text-slate-300">
                  {checkoutUrl(detail.data.token)}
                </code>
                <CopyButton value={checkoutUrl(detail.data.token)} />
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
              <span>Issued {formatDate(detail.data.issuedAt ?? detail.data.createdAt)}</span>
              {detail.data.sentAt && <span>Sent {formatDate(detail.data.sentAt)}</span>}
              {detail.data.paidAt && <span>Paid {formatDate(detail.data.paidAt)}</span>}
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}

function StatusBadge({ invoice }: { invoice: Invoice }) {
  // Overdue is shown in place of "open" because it is the more actionable fact —
  // but it is a rendering of `open` + a date, never a status of its own.
  if (invoice.status === 'open' && invoice.overdue) {
    return <Badge tone="red" dot>overdue</Badge>;
  }
  const tone =
    invoice.status === 'paid'
      ? 'green'
      : invoice.status === 'open'
        ? 'blue'
        : 'gray';
  return (
    <Badge tone={tone} dot>
      {invoice.status}
    </Badge>
  );
}

function money(currency: string, value: string): string {
  return `${currency} ${trim(value)}`;
}

/** Drop trailing zeros from a NUMERIC(38,18) string. */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
}
