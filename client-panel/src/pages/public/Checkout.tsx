import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, Check, ShieldCheck } from 'lucide-react';
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
import PayCrypoMark from '@/components/PayCrypoMark';
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
 *
 * ---------------------------------------------------------------------------
 * SET AS A DOCUMENT, NOT ASSEMBLED FROM BOXES
 *
 * Every screen here opens the same way: a running head, a masthead rule, ONE
 * enormous figure, then a hairline-ruled narrow-label / wide-value spine. The
 * reference implementation of this treatment is LiveCheckoutDemo, which is the
 * marketing site's replica of this very page — the two must not drift, because
 * the whole point of that replica is that a merchant sees what their customer
 * will see. The nested tinted boxes that used to enclose the deposit address,
 * the status and the invoice are gone: a rule and some space say the same thing
 * with less noise, and noise on a page about a stranger's money reads as
 * salesmanship.
 *
 * THE TWO THINGS A CUSTOMER MUST NOT MISREAD are the AMOUNT and the ADDRESS, so
 * they carry the most typographic weight on the page: the amount is the figure,
 * the address is set at reading size in mono with a full-width copy control
 * under it rather than a subtle icon tucked into a corner.
 *
 * ASSET AND NETWORK ARE NEVER NAMED APART. An address is only valid on the chain
 * it was issued on; USDT-BEP20 sent to a TRC20 address is gone. So the pair is
 * stated under the figure, again in the spine, again in the QR caption, and
 * again in the warnings. That repetition is deliberate.
 *
 * COLOUR IS NEVER THE ONLY CARRIER. Amber = waiting on someone or something
 * (both "waiting for your payment" and "confirming on-chain": the money has been
 * seen but is not yet kept), emerald = funds arrived, red = expired or failed —
 * and each ships its WORD as well as its hue. Brand stays interactive-only: the
 * CTA, the radio, the focus ring, the logotype. It never indicates state.
 *
 * MOTION BUDGET: EXACTLY TWO. A checkout that spins and slides reads as
 * unserious, so the page spends its whole budget on the two moments that are
 * genuinely information:
 *   1. the confirmation track, which scales rather than resizes — a width
 *      transition is a layout animation on every frame;
 *   2. the status transition, a single 6px settle when the chain first sees the
 *      payment, keyed so it fires on the CHANGE and not on mount.
 * Nothing loops, nothing enters on page load, and there is no spinner anywhere:
 * where a spinner used to sit there is now a sentence saying what is happening.
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
  // No spinner: a sentence that says what is being waited on is both calmer and
  // more informative than a rotating glyph, and it costs nothing from the
  // two-animation budget.
  if (linkQuery.isLoading) {
    return (
      <Shell>
        <Masthead runhead="Checkout" />
        <p className="mt-6 text-sm text-slate-600 dark:text-slate-400">
          Loading payment details…
        </p>
      </Shell>
    );
  }

  if (linkQuery.isError || !link) {
    return (
      <Shell>
        <DeadEnd
          mark="Not found"
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
          mark="Unavailable"
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
        <Masthead runhead="Receipt" mark={<StatusMark tone="confirmed" label="Confirmed" />} />

        <p className="mt-6 flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          <Check size={16} strokeWidth={2.5} className="shrink-0" aria-hidden />
          Payment received
        </p>
        <Figure amount={trim(status.amountReceived)} unit={status.asset} />
        <p className="figure-label measure">
          {link.merchantName} has been notified. You can close this page.
        </p>

        <dl className="mt-8 space-y-3">
          <SpineRow label="Asset">
            <AssetOnNetwork asset={status.asset} network={status.network} />
          </SpineRow>
          <SpineRow label="Reference">
            <code className="block break-all font-mono text-xs text-slate-700 dark:text-slate-300">
              {status.paymentId}
            </code>
          </SpineRow>
        </dl>
      </Shell>
    );
  }

  // ---- Expired ------------------------------------------------------------
  if (status && (status.status === 'expired' || status.status === 'failed')) {
    const expired = status.status === 'expired';
    return (
      <Shell merchantName={link.merchantName}>
        <DeadEnd
          tone="failed"
          mark={expired ? 'Expired' : 'Failed'}
          title={expired ? 'This payment expired' : 'Payment failed'}
          body={
            expired
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
  const openAmount = !link.amount && !link.fiatAmount;
  const onlyOption = link.options.length === 1 ? link.options[0] : null;

  return (
    <Shell merchantName={link.merchantName}>
      <Masthead
        runhead={invoice ? `Invoice ${invoice.number}` : link.title || 'Payment request'}
      />

      {link.fiatAmount && link.fiatCurrency ? (
        // Priced in the merchant's currency. The customer is told what they
        // owe in that currency, and the crypto amount appears once they pick
        // a coin and it is actually locked — quoting one here would be a
        // number that is already out of date.
        <Figure amount={trim(link.fiatAmount)} unit={link.fiatCurrency} unitLeads />
      ) : link.amount ? (
        <Figure amount={trim(link.amount)} unit={link.asset ?? undefined} />
      ) : (
        <p className="mt-6 text-lg font-medium text-slate-900 dark:text-slate-100">
          Enter an amount
        </p>
      )}

      {link.description && !invoice && (
        <p className="figure-label measure">{link.description}</p>
      )}
      {invoice?.dueDate && (
        <p
          className={`mt-3 text-sm ${
            invoice.overdue
              ? 'font-semibold text-red-600 dark:text-red-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {invoice.overdue ? 'Was due' : 'Due'} {invoice.dueDate}
        </p>
      )}

      {/* The document itself, when this link is an invoice. A customer should be
          able to see what they are being asked to pay for before paying it. Set
          as a ledger — hairlines between the lines, an ink rule above the total —
          rather than a tinted panel with a table inside it. */}
      {invoice && (
        <div className="mt-8">
          <span className="runhead">What this covers</span>
          <table className="mt-3 w-full text-sm">
            <tbody>
              {invoice.items.map((item, i) => (
                <tr key={i} className="align-baseline">
                  <td className="rule py-2.5 pr-3 text-slate-700 dark:text-slate-300">
                    {item.description}
                    {Number(item.quantity) !== 1 && (
                      <span className="num ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                        × {trim(item.quantity)}
                      </span>
                    )}
                  </td>
                  <td className="rule num py-2.5 text-right whitespace-nowrap text-slate-700 dark:text-slate-300">
                    {trim(item.amount)}
                  </td>
                </tr>
              ))}
              {Number(invoice.taxAmount) > 0 && (
                <tr>
                  <td className="rule py-2.5 pr-3 text-slate-500 dark:text-slate-400">Tax</td>
                  <td className="rule num py-2.5 text-right text-slate-500 dark:text-slate-400">
                    {trim(invoice.taxAmount)}
                  </td>
                </tr>
              )}
              <tr>
                <td className="rule-strong py-2.5 pr-3 font-semibold text-slate-900 dark:text-slate-100">
                  Total
                </td>
                <td className="rule-strong num py-2.5 text-right font-semibold whitespace-nowrap text-slate-900 dark:text-slate-100">
                  {invoice.currency} {trim(invoice.total)}
                </td>
              </tr>
            </tbody>
          </table>
          {invoice.notes && (
            <p className="rule measure mt-4 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              {invoice.notes}
            </p>
          )}
        </div>
      )}

      <div className="mt-8 space-y-6">
        {openAmount && (
          <div>
            <label className="label" htmlFor="amount">
              Amount
            </label>
            <input
              id="amount"
              className="input num lining-nums text-xl tracking-tight"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        )}

        {/* Only render a picker when there is something to pick — but ALWAYS
            name the pair, because "which chain" is the question that loses
            money. With one option there is nothing to choose, so it is stated
            as a spine row instead of a control. */}
        {onlyOption ? (
          <dl>
            <SpineRow label="Pay with">
              <AssetOnNetwork asset={onlyOption.symbol} network={onlyOption.network} />
            </SpineRow>
          </dl>
        ) : link.options.length > 1 ? (
          <fieldset>
            <legend className="label">Pay with</legend>
            {/* Native radios: a real radio group is keyboard- and
                screen-reader-correct for free, and `accent-brand-600` is brand
                on a control, which is the one thing brand is for. Each row names
                the asset AND the chain it settles on — never one without the
                other. */}
            <div className="border-b border-slate-200 dark:border-slate-800">
              {link.options.map((o) => {
                const active = choice?.symbol === o.symbol && choice?.network === o.network;
                return (
                  <label
                    key={`${o.network}:${o.symbol}`}
                    className="rule flex cursor-pointer items-center gap-3 py-3"
                  >
                    <input
                      type="radio"
                      name="pay-with"
                      className="h-4 w-4 shrink-0 accent-brand-600"
                      checked={active}
                      onChange={() => setChoice({ symbol: o.symbol, network: o.network })}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm ${
                          active
                            ? 'font-semibold text-slate-900 dark:text-slate-50'
                            : 'font-medium text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {o.symbol}
                        <span className="font-normal text-slate-500 dark:text-slate-400">
                          {' '}
                          · {o.name}
                        </span>
                      </span>
                    </span>
                    <span className="runhead shrink-0 text-[10px]">{o.network}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {error && (
          <p
            role="alert"
            className="flex gap-2 border-t border-red-600 pt-3 text-sm text-red-600 dark:border-red-400 dark:text-red-400"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={start}
          disabled={starting || (openAmount && !amount) || !choice}
          className="btn-primary w-full py-3 text-base"
        >
          {starting ? (
            'Starting…'
          ) : (
            <>
              Continue to payment <ArrowRight size={18} aria-hidden />
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

  const required = status?.requiredConfirmations ?? 0;
  const seen = status?.confirmations ?? 0;
  const progress = required > 0 ? Math.min(seen / required, 1) : 0;

  return (
    <div>
      <Masthead
        runhead="Send payment"
        mark={<StatusMark tone="waiting" label={confirming ? 'Confirming' : 'Waiting'} />}
      />

      {/* THE FIGURE. The single number the customer has to get right. */}
      <Figure amount={trim(payment.amount)} unit={payment.asset} />

      {/* The pair, stated in ink rather than in a coloured pill. Weight is the
          emphasis here on purpose: amber and red mean states on this page, and
          this is an instruction, not a state. */}
      <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        Send <strong className="font-semibold text-slate-900 dark:text-slate-50">
          {payment.asset}
        </strong>{' '}
        on the{' '}
        <strong className="font-semibold text-slate-900 dark:text-slate-50">
          {payment.network}
        </strong>{' '}
        network only. This address accepts nothing else.
      </p>

      {/* Show the conversion when the price was in fiat. A customer asked to
          send an odd number like 36.281418 deserves to see where it came
          from — and that it is held for this payment, not re-quoted. */}
      {payment.fiat && (
        <p className="num mt-2 text-xs text-slate-500 dark:text-slate-400">
          {payment.fiat.currency} {trim(payment.fiat.amount)} at{' '}
          {trim(payment.fiat.rate)} {payment.fiat.currency}/{payment.asset} · held for
          this payment
        </p>
      )}

      {/* For the chain's own coin, say so explicitly. A customer withdrawing
          from an exchange picks a network from a list, and "BNB" appears on
          several — sending BNB over the wrong one loses it. There is also no
          contract address to check here, which is otherwise how a careful
          customer verifies they are sending the right thing. */}
      {isNativeAsset && (
        <p className="measure mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          {payment.asset} is {payment.network}'s own coin, not a token. If you are
          withdrawing from an exchange, choose the {payment.network} network.
        </p>
      )}

      {/* Rendered client-side as SVG rather than using the API's PNG: it stays
          crisp at any size and adapts to the theme. The white plate is not
          decoration — a QR needs a light quiet zone to scan in dark mode. */}
      <div className="rule mt-7 flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:gap-6">
        <div className="w-fit rounded-lg bg-white p-3 ring-1 ring-slate-200 dark:ring-slate-700">
          <QRCodeSVG value={payment.address} size={176} level="M" includeMargin={false} />
        </div>
        <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Scan with any wallet that holds {payment.asset} on {payment.network}, or copy
          the address below.
        </p>
      </div>

      {/* THE ADDRESS. Set at reading size, ranged left, broken on characters so
          no part of it can be cut off — and with a full-width copy control
          rather than a subtle icon, because most customers copy rather than
          scan. */}
      <div className="rule mt-6 pt-5">
        <span className="runhead">Payment address · {payment.network}</span>
        <code className="mt-3 block break-all font-mono text-[15px] leading-relaxed text-slate-900 dark:text-slate-50">
          {payment.address}
        </code>
        <CopyButton
          value={payment.address}
          label="Copy address"
          size={15}
          // CopyButton's own base is a small, quiet icon control. Here it is the
          // second most important thing on the screen, so it is widened into a
          // real button: every class below overrides a base one of the same
          // property, and the failure mode if one does not win is a slightly
          // smaller label on a control that still works.
          className="mt-4 w-full justify-center rounded-lg border border-slate-300 py-3 text-sm font-semibold text-slate-900 hover:text-slate-900 dark:border-slate-700 dark:text-slate-100 dark:hover:text-slate-100"
        />
      </div>

      {/* The spine. */}
      <dl className="mt-6 space-y-3">
        <SpineRow label="Asset">
          <AssetOnNetwork asset={payment.asset} network={payment.network} />
        </SpineRow>
        <SpineRow label={left ? 'Expires in' : 'Expiry'}>
          {left ? (
            <span className="num lining-nums font-medium">{left}</span>
          ) : (
            <span className="text-slate-500 dark:text-slate-400">Window closed</span>
          )}
        </SpineRow>
      </dl>

      {/* Confirmations. It breaks the spine deliberately: this is the line of
          the document that is actually moving. ANIMATION 1 OF 2 — the track
          scales, it does not resize. */}
      {status && required > 0 && (
        <div className="rule mt-3 pt-3">
          <div className="flex items-baseline justify-between gap-4">
            <span className="runhead text-[10px]">Confirmations</span>
            <span className="num lining-nums text-sm text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {seen}
              </span>
              {' / '}
              {required}
            </span>
          </div>
          {/* Square ends: scaleX() on a rounded cap stretches it into an oval. */}
          <div
            className="mt-2 h-[3px] w-full overflow-hidden bg-slate-200 dark:bg-slate-800"
            aria-hidden
          >
            <div
              className="h-full w-full origin-left bg-amber-600 transition-transform duration-[var(--dur-set)] ease-[var(--ease-out)] dark:bg-amber-400"
              style={{ transform: `scaleX(${progress})` }}
            />
          </div>
        </div>
      )}

      {/* Status. Always says what is happening — a bare spinner during a
          multi-minute confirmation wait reads as a broken page.
          ANIMATION 2 OF 2 — the key changes only when the chain first sees the
          payment, so the settle fires on the TRANSITION and never on mount. */}
      <div className="rule mt-3 pt-3" aria-live="polite">
        <div key={confirming ? 'confirming' : 'waiting'} className={confirming ? 'animate-fade-up' : undefined}>
          <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {confirming ? 'Payment detected — confirming on-chain' : 'Waiting for your payment'}
          </p>
          <p className="measure mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {confirming
              ? `${seen} of ${required} confirmations. You can close this page; the merchant is notified automatically.`
              : 'Send the exact amount above from any wallet. This page updates automatically once the funds arrive — you can leave it open.'}
          </p>
        </div>
      </div>

      <ul className="mt-6 border-b border-slate-200 dark:border-slate-800">
        {[
          `Send only ${payment.asset} on ${payment.network}. Other coins or networks are not credited automatically.`,
          'Send the full amount in one transaction where possible.',
          `Paying to ${link.merchantName}.`,
        ].map((t) => (
          <li
            key={t}
            className="rule measure py-2.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
          >
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome + editorial primitives
// ---------------------------------------------------------------------------

function Shell({
  children,
  merchantName,
}: {
  children: React.ReactNode;
  merchantName?: string;
}) {
  return (
    // Plain paper, no mesh. The indigo bloom that used to sit behind this sheet
    // was decoration spending the interactive colour, and a calm ground is worth
    // more here than a gradient: this page has to look like a bank statement,
    // not like a landing page.
    <div className="min-h-screen bg-slate-100 px-4 py-6 dark:bg-slate-950 sm:py-12">
      <div className="mx-auto w-full max-w-lg">
        <div className="mb-4 flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-accent-600 text-white"
              aria-hidden
            >
              <PayCrypoMark size={17} />
            </span>
            {merchantName && (
              <span className="min-w-0 leading-tight">
                <span className="runhead text-[10px]">Paying</span>
                {/* Never truncated. On the choose screen this is the only place
                    the payee is named, and a customer who cannot read who they
                    are paying should not be asked to pay. */}
                <span className="block break-words text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {merchantName}
                </span>
              </span>
            )}
          </span>
          <ThemeToggle />
        </div>

        {/* The sheet. No entrance animation: the page a stranger lands on to send
            money does not arrive from off-screen. */}
        <div className="card p-5 sm:p-8">{children}</div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px] text-slate-500 dark:text-slate-400">
          <ShieldCheck size={12} className="shrink-0 text-slate-400" aria-hidden />
          Secured by {BRAND_NAME} · funds go directly to the merchant
        </p>
      </div>
    </div>
  );
}

/**
 * The head of every screen: a running head on the left, the state on the right,
 * closed by the one heavy stroke the sheet is allowed. Same gesture on the
 * choose screen, the pay screen, the receipt and every dead end, so the page
 * reads as one document in four states rather than four different pages.
 */
function Masthead({ runhead, mark }: { runhead: string; mark?: React.ReactNode }) {
  return (
    <>
      <div className="flex items-baseline justify-between gap-4">
        {/* Wraps rather than truncates: this line carries the merchant's own
            title for the payment, and a clipped one is information lost on the
            screen that can least afford it. */}
        <span className="runhead min-w-0 break-words">{runhead}</span>
        {mark}
      </div>
      <div className="rule-strong mt-3" aria-hidden />
    </>
  );
}

/**
 * ONE ENORMOUS FIGURE PER SCREEN — the amount, always.
 *
 * Deliberately NOT `.figure-xl`: that primitive scales on the VIEWPORT (up to
 * 7.5rem), which is right for a full-bleed marketing band and wrong inside a
 * fixed-measure sheet, where a nine-digit crypto amount would run off the edge.
 * A number the customer cannot fully read is worse than a smaller one. Tabular
 * lining figures for the same reason they are used everywhere else money is
 * shown: proportional digits make a quantity look hand-set at the wrong widths.
 */
function Figure({
  amount,
  unit,
  unitLeads = false,
}: {
  amount: string;
  unit?: string;
  /** Fiat reads "EUR 49.90"; crypto reads "53.85 USDT". */
  unitLeads?: boolean;
}) {
  const u = unit ? (
    <span className="text-base font-medium text-slate-500 dark:text-slate-400 sm:text-lg">
      {unit}
    </span>
  ) : null;

  return (
    <p className="mt-5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      {unitLeads && u}
      {/* `break-words` is a safety valve, not a layout choice: it only engages
          when a figure would otherwise run off the sheet. A number wrapped onto
          two lines can still be read in full; one clipped by the card edge
          cannot, and a digit the customer never sees is the failure this whole
          screen exists to avoid. */}
      <span className="num lining-nums break-words text-[2.25rem] font-semibold leading-[0.95] tracking-[-0.04em] text-slate-900 dark:text-slate-50 sm:text-[2.75rem]">
        {amount}
      </span>
      {!unitLeads && u}
    </p>
  );
}

/** A row of the spine: a narrow label column against a wide value column. */
function SpineRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // The rule belongs to the ROW, not to the two cells: a hairline interrupted
    // by a column gap reads as a mistake rather than as a rule.
    <div className="rule flex items-baseline gap-4 pt-3">
      <dt className="runhead w-[5.5rem] shrink-0 text-[10px]">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-slate-900 dark:text-slate-100">
        {children}
      </dd>
    </div>
  );
}

/** The pair, never one without the other. */
function AssetOnNetwork({ asset, network }: { asset: string; network: string }) {
  return (
    <>
      <span className="font-semibold">{asset}</span>
      <span className="text-slate-500 dark:text-slate-400"> on </span>
      <span className="font-semibold">{network}</span>
    </>
  );
}

type Tone = 'neutral' | 'waiting' | 'confirmed' | 'failed';

const TONES: Record<Tone, { text: string; dot: string }> = {
  neutral: {
    text: 'text-slate-500 dark:text-slate-400',
    dot: 'bg-slate-400 dark:bg-slate-500',
  },
  // Waiting on the customer and waiting on the chain are the same thing: seen,
  // perhaps, but not yet yours. Both are amber, and the WORD tells them apart.
  waiting: {
    text: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-600 dark:bg-amber-400',
  },
  confirmed: {
    text: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-600 dark:bg-emerald-400',
  },
  failed: {
    text: 'text-red-600 dark:text-red-400',
    dot: 'bg-red-600 dark:bg-red-400',
  },
};

/**
 * The state, set as a marginal label rather than a filled chip. Two carriers of
 * meaning, never one: the word says what is happening and the dot repeats it in
 * colour for the reader who is scanning. Nothing pulses — this is a real payment
 * and a throbbing dot is theatre.
 */
function StatusMark({ tone, label }: { tone: Tone; label: string }) {
  const t = TONES[tone];
  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.dot}`} aria-hidden />
      <span className={`runhead ${t.text}`}>{label}</span>
    </span>
  );
}

function DeadEnd({
  title,
  body,
  mark,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  mark: string;
  tone?: Tone;
}) {
  return (
    <div>
      <Masthead runhead="Checkout" mark={<StatusMark tone={tone} label={mark} />} />
      <h2 className="mt-6 text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
        {title}
      </h2>
      <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
        {body}
      </p>
    </div>
  );
}

/** Drop trailing zeros from a NUMERIC(38,18) string — "18.500000…" reads badly. */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
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
