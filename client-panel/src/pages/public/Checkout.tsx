import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Loader2,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  errorMessage,
  getCheckoutStatus,
  getPublicInvoice,
  getPublicLink,
  startCheckoutPayment,
} from '@/lib/api';
import type { CheckoutPayment, PublicLink } from '@/types';
import CopyButton from '@/components/CopyButton';
import ThemeToggle from '@/components/ThemeToggle';
import { BRAND_NAME } from '@/lib/brand';

/**
 * Hosted checkout — the page a customer opens from a shared link.
 *
 * This is the only screen in the product seen by someone who is NOT a merchant,
 * has no account, and may never have used a crypto wallet. Three consequences
 * shape it:
 *
 *  - It must work signed-out and on a phone. Most links are opened from a chat
 *    app, so mobile is the primary layout, not the fallback.
 *  - It must never show a spinner with no explanation. Waiting for chain
 *    confirmations takes minutes; the page says what is happening and what the
 *    customer should do (nothing).
 *  - It shows exactly what the API returns and nothing more. There is no
 *    merchant identity here beyond a business name — see the note on the public
 *    surface in backend/src/routes/paymentLinks.ts.
 *
 * State machine: choose -> pay -> (confirming) -> done | expired.
 */

type Phase = 'choose' | 'pay';

const TERMINAL = ['confirmed', 'swept', 'failed', 'expired'];

export default function Checkout() {
  const { token = '' } = useParams();
  const [phase, setPhase] = useState<Phase>('choose');
  const [payment, setPayment] = useState<CheckoutPayment | null>(null);
  const [choice, setChoice] = useState<{ symbol: string; network: string } | null>(null);
  const [amount, setAmount] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const linkQuery = useQuery({
    queryKey: ['public-link', token],
    queryFn: () => getPublicLink(token),
    retry: false,
  });
  const link = linkQuery.data;

  // The invoice behind this link, when there is one. `hasInvoice` on the link
  // tells us whether to ask at all, so a plain checkout link never issues a
  // request that is always going to 404.
  const invoiceQuery = useQuery({
    queryKey: ['public-invoice', token],
    queryFn: () => getPublicInvoice(token),
    enabled: Boolean(link?.hasInvoice),
    retry: false,
  });
  const invoice = invoiceQuery.data ?? null;

  // Preselect when there is nothing to decide.
  useEffect(() => {
    if (link && !choice && link.options.length > 0) {
      setChoice({ symbol: link.options[0].symbol, network: link.options[0].network });
    }
  }, [link, choice]);

  // Poll while the payment is live. Stops on a terminal status so a finished
  // page does not keep hitting the API from a tab left open for hours.
  //
  // The two overrides below are load-bearing for the ACTUAL customer journey:
  // open the link, switch to a wallet app, send, switch back. That backgrounds
  // the tab, and by default React Query pauses interval refetches while the
  // document is hidden — while this app's global config also disables
  // refetch-on-focus. Without both overrides the customer returns to a page
  // frozen on "waiting for your payment" after they have already paid.
  const statusQuery = useQuery({
    queryKey: ['checkout-status', token, payment?.paymentId],
    queryFn: () => getCheckoutStatus(token, payment!.paymentId),
    enabled: Boolean(payment?.paymentId),
    refetchInterval: (q) =>
      q.state.data && TERMINAL.includes(q.state.data.status) ? false : 6_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    // The status changes on-chain, not here — never serve a cached copy.
    staleTime: 0,
  });
  const status = statusQuery.data;

  const start = async () => {
    if (!link) return;
    setError(null);
    setStarting(true);
    try {
      const created = await startCheckoutPayment(token, {
        asset: choice?.symbol,
        network: choice?.network,
        // A fixed price — crypto or fiat — always wins; `amount` is only
        // consulted for an open-amount link, and the server enforces that too.
        amount: link.amount || link.fiatAmount ? undefined : amount,
      });
      setPayment(created);
      setPhase('pay');
    } catch (err) {
      setError(errorMessage(err, 'Could not start this payment. Please try again.'));
    } finally {
      setStarting(false);
    }
  };

  // ---- Loading / dead-end states -----------------------------------------
  if (linkQuery.isLoading) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-16">
          <Loader2 className="animate-spin text-brand-600" size={28} />
          <p className="text-sm text-slate-500">Loading payment details…</p>
        </div>
      </Shell>
    );
  }

  if (linkQuery.isError || !link) {
    return (
      <Shell>
        <DeadEnd
          title="Payment link not found"
          body="This link doesn't exist, or it has been removed. Check the link with whoever sent it to you."
        />
      </Shell>
    );
  }

  if (!link.usable) {
    return (
      <Shell merchantName={link.merchantName}>
        <DeadEnd
          title="This link is no longer active"
          body={link.unusableReason ?? 'This payment link cannot be used.'}
        />
      </Shell>
    );
  }

  // ---- Paid ---------------------------------------------------------------
  if (status && (status.status === 'confirmed' || status.status === 'swept')) {
    return (
      <Shell merchantName={link.merchantName}>
        <div className="flex flex-col items-center gap-4 py-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-brand-600/10 text-brand-600 dark:bg-brand-400/10 dark:text-brand-400">
            <CheckCircle2 size={34} />
          </span>
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-50">
              Payment received
            </h2>
            <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">
              {link.merchantName} has been notified. You can close this page.
            </p>
          </div>
          <dl className="w-full space-y-2 rounded-2xl bg-slate-50 p-4 text-sm dark:bg-slate-800/50">
            <Row label="Paid">
              <span className="num font-semibold">
                {trim(status.amountReceived)} {status.asset}
              </span>
            </Row>
            <Row label="Network">{status.network}</Row>
            <Row label="Reference">
              <code className="font-mono text-xs">{status.paymentId.slice(0, 18)}…</code>
            </Row>
          </dl>
        </div>
      </Shell>
    );
  }

  // ---- Expired ------------------------------------------------------------
  if (status && (status.status === 'expired' || status.status === 'failed')) {
    return (
      <Shell merchantName={link.merchantName}>
        <DeadEnd
          title={status.status === 'expired' ? 'This payment expired' : 'Payment failed'}
          body={
            status.status === 'expired'
              ? 'The payment window closed before funds arrived. If you already sent them, contact the merchant — the transaction is on-chain and recoverable.'
              : 'Something went wrong with this payment. Contact the merchant before sending again.'
          }
        />
      </Shell>
    );
  }

  // ---- Awaiting payment ---------------------------------------------------
  if (phase === 'pay' && payment) {
    return (
      <Shell merchantName={link.merchantName}>
        <PayPanel link={link} payment={payment} status={status ?? null} />
      </Shell>
    );
  }

  // ---- Choose ------------------------------------------------------------
  const grouped = groupByNetwork(link.options);

  return (
    <Shell merchantName={link.merchantName}>
      <div className="text-center">
        <p className="text-sm text-slate-500">
          {invoice ? `Invoice ${invoice.number}` : link.title}
        </p>
        {link.fiatAmount && link.fiatCurrency ? (
          // Priced in the merchant's currency. The customer is told what they
          // owe in that currency, and the crypto amount appears once they pick
          // a coin and it is actually locked — quoting one here would be a
          // number that is already out of date.
          <p className="mt-1 num text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            <span className="text-2xl text-slate-400">{link.fiatCurrency}</span>{' '}
            {trim(link.fiatAmount)}
          </p>
        ) : link.amount ? (
          <p className="mt-1 text-4xl font-bold num tracking-tight text-slate-900 dark:text-slate-50">
            {trim(link.amount)}{' '}
            <span className="text-2xl text-slate-400">{link.asset ?? ''}</span>
          </p>
        ) : (
          <p className="mt-1 text-lg font-medium text-slate-700 dark:text-slate-300">
            Enter an amount
          </p>
        )}
        {link.description && !invoice && (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            {link.description}
          </p>
        )}
        {invoice?.dueDate && (
          <p
            className={`mt-2 text-sm ${
              invoice.overdue
                ? 'font-medium text-red-600 dark:text-red-400'
                : 'text-slate-500'
            }`}
          >
            {invoice.overdue ? 'Was due' : 'Due'} {invoice.dueDate}
          </p>
        )}
      </div>

      {/* The document itself, when this link is an invoice. A customer should be
          able to see what they are being asked to pay for before paying it. */}
      {invoice && (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-800/40">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
              {invoice.items.map((item, i) => (
                <tr key={i}>
                  <td className="py-2 pr-3 text-slate-700 dark:text-slate-300">
                    {item.description}
                    {Number(item.quantity) !== 1 && (
                      <span className="ml-1.5 text-xs text-slate-400">
                        × {trim(item.quantity)}
                      </span>
                    )}
                  </td>
                  <td className="num py-2 text-right whitespace-nowrap text-slate-700 dark:text-slate-300">
                    {trim(item.amount)}
                  </td>
                </tr>
              ))}
              {Number(invoice.taxAmount) > 0 && (
                <tr>
                  <td className="py-2 pr-3 text-slate-500">Tax</td>
                  <td className="num py-2 text-right text-slate-500">
                    {trim(invoice.taxAmount)}
                  </td>
                </tr>
              )}
              <tr>
                <td className="py-2 pr-3 font-semibold text-slate-900 dark:text-slate-100">
                  Total
                </td>
                <td className="num py-2 text-right font-semibold whitespace-nowrap text-slate-900 dark:text-slate-100">
                  {invoice.currency} {trim(invoice.total)}
                </td>
              </tr>
            </tbody>
          </table>
          {invoice.notes && (
            <p className="mt-3 border-t border-slate-200 pt-3 text-xs text-slate-500 dark:border-slate-700">
              {invoice.notes}
            </p>
          )}
        </div>
      )}

      <div className="mt-7 space-y-5">
        {!link.amount && !link.fiatAmount && (
          <div>
            <label className="label" htmlFor="amount">
              Amount
            </label>
            <input
              id="amount"
              className="input num text-lg"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        )}

        {/* Only render a picker when there is something to pick. */}
        {link.options.length > 1 && (
          <div>
            <p className="label">Pay with</p>
            <div className="space-y-3">
              {Object.entries(grouped).map(([network, opts]) => (
                <div key={network}>
                  <p className="section-label mb-1.5">{network}</p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {opts.map((o) => {
                      const active =
                        choice?.symbol === o.symbol && choice?.network === o.network;
                      return (
                        <button
                          key={`${o.network}:${o.symbol}`}
                          type="button"
                          onClick={() => setChoice({ symbol: o.symbol, network: o.network })}
                          className={`rounded-xl border px-3 py-2.5 text-left transition ${
                            active
                              ? 'border-brand-500 bg-brand-50/70 ring-2 ring-brand-500/20 dark:bg-brand-900/20'
                              : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                          }`}
                        >
                          <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
                            {o.symbol}
                          </span>
                          <span className="block truncate text-[11px] text-slate-500">
                            {o.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="flex gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:bg-red-900/25 dark:text-red-300"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={start}
          disabled={
            starting || (!link.amount && !link.fiatAmount && !amount) || !choice
          }
          className="btn-primary w-full py-3 text-base"
        >
          {starting ? (
            <Loader2 className="animate-spin" size={18} />
          ) : (
            <>
              Continue to payment <ArrowRight size={18} />
            </>
          )}
        </button>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Awaiting-payment panel
// ---------------------------------------------------------------------------

function PayPanel({
  link,
  payment,
  status,
}: {
  link: PublicLink;
  payment: CheckoutPayment;
  status: { status: string; confirmations: number; requiredConfirmations: number } | null;
}) {
  const left = useCountdownTo(payment.expiresAt);
  const confirming = status?.status === 'confirming';
  // Resolved from the link's own option list rather than a hardcoded symbol
  // check, so a chain added later needs no change here.
  const isNativeAsset = Boolean(
    link.options.find(
      (o) => o.symbol === payment.asset && o.network === payment.network,
    )?.isNative,
  );

  return (
    <div>
      <div className="text-center">
        <p className="text-sm text-slate-500">Send exactly</p>
        <p className="mt-1 text-3xl font-bold num tracking-tight text-slate-900 dark:text-slate-50">
          {trim(payment.amount)}{' '}
          <span className="text-xl text-slate-400">{payment.asset}</span>
        </p>
        {/* Show the conversion when the price was in fiat. A customer asked to
            send an odd number like 36.281418 deserves to see where it came
            from — and that it is held for this payment, not re-quoted. */}
        {payment.fiat && (
          <p className="mt-1 text-xs text-slate-500">
            {payment.fiat.currency} {trim(payment.fiat.amount)} at{' '}
            {trim(payment.fiat.rate)} {payment.fiat.currency}/{payment.asset} ·
            held for this payment
          </p>
        )}
        <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 dark:bg-amber-900/25 dark:text-amber-300">
          on the {payment.network} network only
        </p>
        {/* For the chain's own coin, say so explicitly. A customer withdrawing
            from an exchange picks a network from a list, and "BNB" appears on
            several — sending BNB over the wrong one loses it. There is also no
            contract address to check here, which is otherwise how a careful
            customer verifies they are sending the right thing. */}
        {isNativeAsset && (
          <p className="mt-2 text-xs text-slate-500">
            {payment.asset} is {payment.network}'s own coin, not a token. If you
            are withdrawing from an exchange, choose the {payment.network} network.
          </p>
        )}
      </div>

      {/* Rendered client-side as SVG rather than using the API's PNG: it stays
          crisp at any size and adapts to the theme. */}
      <div className="mt-6 flex justify-center">
        <div className="rounded-2xl bg-white p-4 shadow-soft ring-1 ring-slate-200 dark:ring-slate-700">
          <QRCodeSVG value={payment.address} size={188} level="M" includeMargin={false} />
        </div>
      </div>

      <div className="mt-6">
        <p className="label">Deposit address</p>
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/60">
          <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-slate-800 dark:text-slate-200">
            {payment.address}
          </code>
          <CopyButton value={payment.address} />
        </div>
      </div>

      {/* Status. Always says what is happening — a bare spinner during a
          multi-minute confirmation wait reads as a broken page. */}
      <div className="mt-6 rounded-2xl border border-slate-200 p-4 dark:border-slate-700">
        {confirming ? (
          <div className="flex gap-3">
            <Loader2 className="mt-0.5 shrink-0 animate-spin text-brand-600" size={18} />
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Payment detected — confirming on-chain
              </p>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                {status!.confirmations} of {status!.requiredConfirmations} confirmations.
                You can close this page; the merchant is notified automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex gap-3">
            <Clock className="mt-0.5 shrink-0 text-slate-400" size={18} />
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Waiting for your payment
              </p>
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                {left ? (
                  <>
                    This address is reserved for <strong className="num">{left}</strong>.
                  </>
                ) : (
                  'This page updates automatically once funds arrive.'
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      <ul className="mt-5 space-y-1.5 text-xs text-slate-500">
        <li>· Send only {payment.asset} on {payment.network}. Other coins or networks are not credited automatically.</li>
        <li>· Send the full amount in one transaction where possible.</li>
        <li>· Paying to {link.merchantName}.</li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome + helpers
// ---------------------------------------------------------------------------

function Shell({
  children,
  merchantName,
}: {
  children: React.ReactNode;
  merchantName?: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50 bg-mesh px-4 py-8 dark:bg-slate-950 sm:py-14">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-5 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-600 text-white">
              <ShieldCheck size={17} strokeWidth={2.25} />
            </span>
            {merchantName && (
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {merchantName}
              </span>
            )}
          </span>
          <ThemeToggle />
        </div>

        <div className="card animate-fade-up p-6 sm:p-8">{children}</div>

        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-slate-400">
          <ShieldCheck size={13} />
          Secured by {BRAND_NAME} · funds go directly to the merchant
        </p>
      </div>
    </div>
  );
}

function DeadEnd({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800">
        <Wallet size={26} />
      </span>
      <div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-slate-50">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          {body}
        </p>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-slate-800 dark:text-slate-200">{children}</dd>
    </div>
  );
}

/** Drop trailing zeros from a NUMERIC(38,18) string — "18.500000…" reads badly. */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
}

function groupByNetwork(options: PublicLink['options']) {
  return options.reduce<Record<string, PublicLink['options']>>((acc, o) => {
    (acc[o.network] ??= []).push(o);
    return acc;
  }, {});
}

/** mm:ss until `iso`, or null once it has passed. */
function useCountdownTo(iso: string): string | null {
  const target = useMemo(() => new Date(iso).getTime(), [iso]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = target - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}
