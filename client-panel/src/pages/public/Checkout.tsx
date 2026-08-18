import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, Check, Clock, ShieldCheck } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  errorMessage,
  getCheckoutStatus,
  getPublicInvoice,
  getPublicLink,
  startCheckoutPayment,
} from '@/lib/api';
import type { CheckoutPayment, PublicLink } from '@/types';
import Badge from '@/components/Badge';
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
 *    app, so mobile is the primary layout, not the fallback. Every measurement
 *    below is taken at 360px first and relaxed upward, never the other way.
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
 * ONE COLUMN, ONE SHEET, AN INSET PANEL AT THE CENTRE OF IT
 *
 * The outgoing version was set as a broadsheet: a masthead rule, ranged-left
 * measures, and hairline-divided bands doing the structural work. It has been
 * rebuilt in the product's own language — a lit surface floating on a plain
 * ground — because a checkout that looks like a different product from the
 * dashboard that issued it is exactly the "unrelated layout quirk" that makes a
 * stranger suspect the page is a clone.
 *
 * THIS PAGE DELIBERATELY DOES NOT MOUNT THE DEPTH FIELD. Every other route in
 * the app floats on the aurora; here the ground is plain (see the note in
 * DepthField.tsx, which records the same decision from the other side). A
 * stranger about to send money should be looking at an amount and an address,
 * not at atmosphere, and a drifting gradient behind a payment page reads as
 * marketing.
 *
 * WHY THE PAYMENT BLOCK IS A `.well` AND NOTHING ELSE ON THE PAGE IS. Visually
 * sectioning the sensitive region is the single strongest lever on perceived
 * security — stronger than any badge or seal, and it matters most for a brand
 * the payer has never heard of, which is this one, always. `.well` is the
 * system's inset surface: it recedes rather than lifts, which is the correct
 * reading for a thing you reach INTO to take something out. Nothing else on the
 * sheet gets its own container, so the encasing means something.
 *
 * THE TWO THINGS A CUSTOMER MUST NOT MISREAD are the AMOUNT and the ADDRESS, so
 * they carry the most typographic weight on the page: the amount is the figure,
 * the address is set at 16px in mono with a full-width copy control under it
 * rather than a subtle icon tucked into a corner. Neither is ever truncated —
 * both break rather than clip, because a digit the customer never sees is the
 * failure this whole screen exists to avoid.
 *
 * ASSET AND NETWORK ARE NEVER NAMED APART. An address is only valid on the chain
 * it was issued on; USDT-BEP20 sent to a TRC20 address is gone. So the pair is
 * stated under the figure, again on the payment panel's own top strip, again in
 * the QR caption, again in the spine, and again in the closing notes. That
 * repetition is deliberate — a payer withdrawing from an exchange is
 * pattern-matching our string against a dropdown on another screen, and every
 * extra place they can find it is another chance to catch a mismatch.
 *
 * COLOUR IS NEVER THE ONLY CARRIER. Amber = waiting on someone or something
 * (both "waiting for your payment" and "confirming on-chain": the money has been
 * seen but is not yet kept), emerald = funds arrived, red = expired or failed —
 * and each ships its WORD as well as its hue, plus the lozenge's shape. Brand
 * stays interactive-only: the CTA, the radio, the focus ring, the logotype. It
 * never indicates state. The wrong-network instruction is set in INK rather than
 * in amber for exactly this reason — it is an instruction, not a state, and
 * spending a state hue on it would blunt the hue where it does mean something.
 *
 * MOTION BUDGET: EXACTLY THREE. A checkout that spins and slides reads as
 * unserious, so the page spends its whole budget on the three moments that are
 * genuinely information:
 *   1. the live status lozenge's halo — the one loop this design permits
 *      product-wide, and the highest-value animation on the page: it is what
 *      says the page is awake and watching while the payer is in their wallet
 *      app. `<Badge dot>` supplies it, and it stops dead on a terminal status;
 *   2. the confirmation track, which SCALES rather than resizes — a width
 *      transition is a layout animation on every frame;
 *   3. the status transition, a single 6px settle when the chain first sees the
 *      payment, keyed so it fires on the CHANGE and not on mount.
 * Nothing enters on page load. THERE IS NO SPINNER ANYWHERE: where a spinner
 * would sit there is a sentence saying what is happening, because an
 * indeterminate spinner on a money page is anxiety carrying no information.
 *
 * LiveCheckoutDemo is the marketing site's replica of this screen and the two
 * must not drift — the whole point of that replica is that a merchant sees what
 * their customer will see. Every shared element (the head, the figure, the
 * payment well, the spine, the confirmation track, the status lozenge) is built
 * from the same classes in both files. Change one, change the other.
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
  // No spinner and no shimmer: a sentence that says what is being waited on is
  // both calmer and more informative than a rotating glyph, and a shimmering
  // placeholder implies content that may never arrive. It also costs nothing
  // from the three-animation budget.
  if (linkQuery.isLoading) {
    return (
      <Shell>
        <SheetHead title="Checkout" />
        <SheetBody>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Loading payment details…
          </p>
        </SheetBody>
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
        <SheetHead title="Receipt" badge={<Badge tone="settled" dot>Confirmed</Badge>} />
        <SheetBody>
          {/* The word first, in emerald, with a check beside it. Three carriers
              again: glyph, word, hue. No confetti and no draw-on flourish —
              money moved, and this is a receipt. */}
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
            <Check size={16} strokeWidth={2.5} className="shrink-0" aria-hidden />
            Payment received
          </p>
          <Figure amount={trim(status.amountReceived)} unit={status.asset} className="mt-3" />
          <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {link.merchantName} has been notified. You can close this page.
          </p>

          <dl className="mt-5">
            <SpineRow label="Asset">
              <AssetOnNetwork asset={status.asset} network={status.network} />
            </SpineRow>
            <SpineRow label="Reference">
              {/* `text-left` against `.spine-value`'s right rag, and only here.
                  A ranged-right identifier that wraps leaves a short orphan
                  segment hanging under a long one, which on the one string a
                  payer may have to read back to support is worth the exception.
                  Everything else in the spine is short enough to range right. */}
              <code className="block break-all text-left font-mono text-xs text-slate-700 dark:text-slate-300">
                {status.paymentId}
              </code>
            </SpineRow>
          </dl>
        </SheetBody>
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
      <SheetHead title={invoice ? `Invoice ${invoice.number}` : link.title || 'Payment request'} />
      <SheetBody>
        {link.fiatAmount && link.fiatCurrency ? (
          // Priced in the merchant's currency. The customer is told what they
          // owe in that currency, and the crypto amount appears once they pick
          // a coin and it is actually locked — quoting one here would be a
          // number that is already out of date.
          <Figure amount={trim(link.fiatAmount)} unit={link.fiatCurrency} unitLeads />
        ) : link.amount ? (
          <Figure amount={trim(link.amount)} unit={link.asset ?? undefined} />
        ) : (
          <p className="text-lg font-medium text-slate-900 dark:text-slate-100">
            Enter an amount
          </p>
        )}

        {link.description && !invoice && (
          <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            {link.description}
          </p>
        )}
        {invoice?.dueDate && (
          <p
            className={`mt-3 flex items-center gap-1.5 text-sm ${
              invoice.overdue
                ? 'font-semibold text-red-600 dark:text-red-400'
                : 'text-slate-500 dark:text-slate-400'
            }`}
          >
            <Clock size={14} className="shrink-0" aria-hidden />
            {invoice.overdue ? 'Was due' : 'Due'} {invoice.dueDate}
          </p>
        )}

        {/* The document itself, when this link is an invoice. A customer should
            be able to see what they are being asked to pay for before paying
            it.

            IT IS A LIST, NOT A TABLE, and that is a 360px fix rather than a
            stylistic one. A `<table>` resolves its own intrinsic minimum width
            from its longest unbreakable cell, so one long line description used
            to push the whole thing wider than the sheet and hand the payer a
            horizontal scrollbar on the screen that can least afford one. Two
            flex rows cannot do that: the description wraps, and the amount —
            which must never wrap, since a broken figure is a misread figure —
            keeps its intrinsic width via `shrink-0`. */}
        {invoice && (
          <div className="mt-6">
            <span className="runhead">What this covers</span>
            <ul className="mt-2">
              {invoice.items.map((item, i) => (
                <li
                  key={i}
                  className="rule flex items-baseline justify-between gap-3 py-2.5 text-sm"
                >
                  <span className="min-w-0 text-slate-700 dark:text-slate-300">
                    {item.description}
                    {Number(item.quantity) !== 1 && (
                      <span className="num ml-1.5 text-xs text-slate-500 dark:text-slate-400">
                        × {trim(item.quantity)}
                      </span>
                    )}
                  </span>
                  <span className="num shrink-0 text-slate-700 dark:text-slate-300">
                    {trim(item.amount)}
                  </span>
                </li>
              ))}
              {Number(invoice.taxAmount) > 0 && (
                <li className="rule flex items-baseline justify-between gap-3 py-2.5 text-sm text-slate-500 dark:text-slate-400">
                  <span className="min-w-0">Tax</span>
                  <span className="num shrink-0">{trim(invoice.taxAmount)}</span>
                </li>
              )}
              <li className="rule flex items-baseline justify-between gap-3 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                <span className="min-w-0">Total</span>
                <span className="num shrink-0">
                  {invoice.currency} {trim(invoice.total)}
                </span>
              </li>
            </ul>
            {invoice.notes && (
              <p className="rule measure mt-4 pt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                {invoice.notes}
              </p>
            )}
          </div>
        )}

        <div className="mt-6 space-y-5">
          {openAmount && (
            <div>
              <label className="label" htmlFor="amount">
                Amount
              </label>
              {/* `text-xl` here is safely ABOVE `.input`'s 16px mobile floor, so
                  it cannot reintroduce the iOS focus-zoom the floor exists to
                  prevent. This is the only input on the entire checkout, and it
                  only appears on an open-amount link. */}
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
                  on a control, which is the one thing brand is for.

                  EACH OPTION IS A ROW YOU CAN HIT WITH A THUMB — 52px, an inset
                  fill so it reads as a target rather than as a line of text, and
                  a brand wash plus a brand rim when selected. The outgoing
                  version was a hairline-ruled list, which on a phone is four
                  16px radios floating in white space. Selection is carried by
                  the radio itself, by weight, and by the wash — three carriers,
                  so it survives greyscale. */}
              <div className="grid gap-2">
                {link.options.map((o) => {
                  const active = choice?.symbol === o.symbol && choice?.network === o.network;
                  return (
                    <label
                      key={`${o.network}:${o.symbol}`}
                      className={`flex min-h-[52px] cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-[var(--dur-press)] ease-[var(--ease-out)] ${
                        active
                          ? 'border-brand-500/55 bg-brand-500/10'
                          : 'border-[var(--line)] bg-[var(--surface-2)]'
                      }`}
                    >
                      {/* The accessible name is the PAIR, spelled out. The
                          visible row says "USDT" over "Tether on Tron" with the
                          chain in a chip off to the right, which reads fine but
                          announces as three loose fragments; a payer using a
                          screen reader has to hear "on TRC20" attached to the
                          option they are selecting, because that is the fact
                          that loses the money. */}
                      <input
                        type="radio"
                        name="pay-with"
                        aria-label={`${o.symbol} on ${o.network} — ${o.name}`}
                        className="h-4 w-4 shrink-0 accent-brand-600"
                        checked={active}
                        onChange={() => setChoice({ symbol: o.symbol, network: o.network })}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block text-sm ${
                            active
                              ? 'font-semibold text-slate-900 dark:text-slate-50'
                              : 'font-medium text-slate-700 dark:text-slate-300'
                          }`}
                        >
                          {o.symbol}
                        </span>
                        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                          {o.name}
                        </span>
                      </span>
                      {/* The chain, never omitted, never smaller than 12px. */}
                      <span className="chip shrink-0">{o.network}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          {error && (
            <p
              role="alert"
              className="flex gap-2 rounded-lg border border-red-600/25 bg-red-600/[0.06] p-3 text-sm leading-relaxed text-red-600 dark:border-red-400/25 dark:bg-red-400/[0.07] dark:text-red-400"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
              {error}
            </p>
          )}

          {/* Full width and in the thumb zone. `.btn-primary-lg` carries the
              48px floor, so there is no hand-rolled padding to get wrong. */}
          <button
            type="button"
            onClick={start}
            disabled={starting || (openAmount && !amount) || !choice}
            className="btn-primary-lg w-full"
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
      </SheetBody>
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
    <>
      <SheetHead
        title="Send payment"
        badge={
          // ANIMATION 1 OF 3 lives in here: `dot` on a waiting tone gets
          // `.st-live`, whose halo is the one loop the design system permits
          // product-wide. On this page it is doing real work — it is the only
          // thing telling a payer who has come back from their wallet app that
          // the page is still watching the chain.
          <Badge tone="waiting" dot>
            {confirming ? 'Confirming' : 'Waiting'}
          </Badge>
        }
      />
      <SheetBody>
        {/* THE FIGURE. The single number the customer has to get right, and the
            heaviest type on the page. */}
        <Figure amount={trim(payment.amount)} unit={payment.asset} />

        {/* Show the conversion when the price was in fiat. A customer asked to
            send an odd number like 36.281418 deserves to see where it came
            from — and that it is held for this payment, not re-quoted. */}
        {payment.fiat && (
          <p className="num mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {payment.fiat.currency} {trim(payment.fiat.amount)} at{' '}
            {trim(payment.fiat.rate)} {payment.fiat.currency}/{payment.asset} · held for
            this payment
          </p>
        )}

        {/* THE COUNTDOWN, next to the figure it qualifies rather than buried in
            the spine four blocks down — it is one of the four things a payer
            actually uses, and it decides whether they open their wallet now or
            later.

            NO DEPLETING RING, NO PULSE, NO SHAKE. Those are panic devices, and
            on a page about a stranger's money panic converts to abandonment
            rather than to urgency. Under two minutes the ink shifts to amber —
            "waiting on something", which is precisely what this is — and the
            digits themselves are the other carrier, so the shift is never the
            only signal. Tabular numerals stop the whole line from jittering
            once a second, which is its own small anxiety. */}
        <p
          className={`mt-2 flex items-center gap-1.5 text-sm ${
            left?.urgent
              ? 'font-medium text-amber-600 dark:text-amber-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          <Clock size={14} className="shrink-0" aria-hidden />
          {left ? (
            <>
              Expires in{' '}
              <span className="num lining-nums font-semibold tabular-nums">{left.label}</span>
            </>
          ) : (
            'Payment window closed'
          )}
        </p>

        {/* The pair, stated in ink rather than in a coloured pill. Weight is the
            emphasis here on purpose: amber and red mean states on this page, and
            this is an instruction, not a state. */}
        <p className="measure mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Send <strong className="font-semibold text-slate-900 dark:text-slate-50">
            {payment.asset}
          </strong>{' '}
          on the{' '}
          <strong className="font-semibold text-slate-900 dark:text-slate-50">
            {payment.network}
          </strong>{' '}
          network only. This address accepts nothing else.
        </p>

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

        {/* ==============================================================
            THE PAYMENT PANEL — the encased block, and the only container on
            the sheet. Everything a payer physically does lives inside it: scan,
            read, copy. It is `.well` (inset, no rim light — light does not
            catch on the top edge of a hole), which is what makes it read as
            distinct from the document around it without inventing a treatment.
            ============================================================== */}
        <div className="well mt-5 p-3 sm:p-4">
          {/* THE NETWORK IS PART OF THE ADDRESS'S IDENTITY, not a banner over
              it. Payers are banner-blind to yellow warning strips; they are not
              blind to the label on the thing they are about to copy. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="runhead">Payment address</span>
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">
              {payment.asset} · {payment.network}
            </span>
          </div>

          {/* THE QR.
              Rendered client-side as SVG rather than using the API's PNG: it
              stays crisp at any size and needs no network round trip.

              THE PLATE IS WHITE IN BOTH THEMES AND THAT IS NOT DECORATION. An
              inverted QR fails on a meaningful share of scanners, and this is
              the one element on the page that cannot be allowed to fail. The
              16px of white padding is the quiet zone — roughly the four modules
              the spec asks for at this module size — which is why the padding
              is on the plate and not on the well.

              IT SCALES WITH THE COLUMN. `size` only seeds the SVG's width and
              height attributes; `w-full h-auto` overrides both against the
              viewBox, so the code lands at ~200px on a 360px phone and 240px
              from `sm` up, which is the range where a version 10-13 code stays
              comfortably scannable. It never animates — a QR mid-transition is
              a QR that fails to scan. */}
          <div className="mx-auto mt-3 w-full max-w-[14.5rem] rounded-xl bg-white p-4 ring-1 ring-slate-200 sm:max-w-[17.5rem] sm:p-5 dark:ring-slate-700">
            <QRCodeSVG
              value={payment.address}
              size={240}
              level="M"
              includeMargin={false}
              className="block h-auto w-full"
            />
          </div>
          <p className="mt-3 text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Scan with any wallet holding {payment.asset} on {payment.network}, or copy
            the address below.
          </p>

          {/* THE ADDRESS.
              16px, which is a functional floor rather than a typographic
              preference: below it iOS zooms the viewport when a payer taps to
              select and never zooms back. `break-all` because an address has no
              break opportunities of its own, and the alternative — the
              `0x71C7…976F` truncation every wallet UI uses — is precisely the
              pattern address-poisoning attacks are built to defeat. Never
              `user-select: none`: some payers will select it by hand and they
              are entitled to. */}
          <code className="mt-3 block break-all font-mono text-base leading-relaxed text-slate-900 dark:text-slate-50">
            {payment.address}
          </code>

          {/* THE COPY CONTROL. Full width, labelled, 44px — not an icon tucked
              into a corner. Copying is the primary path on this page: a deep
              link cannot help a desktop payer or anyone withdrawing from an
              exchange's withdrawal screen, which is a very large share of
              stablecoin payments.

              Every class below overrides a base one of the same property on
              CopyButton's small, quiet default, and it works because these
              utilities sort AFTER the base ones in Tailwind's own order. The
              failure mode if one ever does not win is a slightly smaller label
              on a control that still copies. */}
          <CopyButton
            value={payment.address}
            label="Copy address"
            size={16}
            className="mt-3 min-h-[44px] w-full justify-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm font-semibold text-slate-900 shadow-soft hover:bg-[var(--hover)] hover:text-slate-900 dark:text-slate-100 dark:hover:text-slate-100"
          />
        </div>

        {/* Status. Always says what is happening — a bare spinner during a
            multi-minute confirmation wait reads as a broken page.
            ANIMATION 3 OF 3 — the key changes only when the chain first sees the
            payment, so the settle fires on the TRANSITION and never on mount. */}
        <div className="rule mt-5 pt-4" aria-live="polite">
          <div
            key={confirming ? 'confirming' : 'waiting'}
            className={confirming ? 'animate-fade-up' : undefined}
          >
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {confirming ? 'Payment detected — confirming on-chain' : 'Waiting for your payment'}
            </p>
            <p className="measure mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {confirming
                ? `${seen} of ${required} confirmations. You can close this page; the merchant is notified automatically.`
                : 'Send the exact amount above from any wallet. This page updates automatically once the funds arrive — you can leave it open.'}
            </p>
          </div>

          {/* Confirmations — a DETERMINATE track, which is the whole reason it
              is allowed to exist where a spinner is not: n of m plus a visible
              proportion is information a payer can reason about.
              ANIMATION 2 OF 3 — the track SCALES, it does not resize. */}
          {status && required > 0 && (
            <div className="mt-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="runhead">Confirmations</span>
                <span className="num lining-nums text-sm text-slate-500 dark:text-slate-400">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    {seen}
                  </span>
                  {' / '}
                  {required}
                </span>
              </div>
              {/* Square ends: scaleX() on a rounded cap stretches it into an
                  oval. Amber, because a confirmation that has not landed is
                  still money waiting on something. */}
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
        </div>

        {/* The spine. The pair again — this is the fourth naming of it on the
            screen and the repetition is the point. */}
        <dl className="mt-5">
          <SpineRow label="Asset">
            <AssetOnNetwork asset={payment.asset} network={payment.network} />
          </SpineRow>
          <SpineRow label="Paying">
            <span className="font-medium">{link.merchantName}</span>
          </SpineRow>
        </dl>

        {/* The closing notes. `.rule` puts a hairline ABOVE each item, so the
            list needs its own bottom border to be closed off — without it the
            last note trails into the sheet's padding and the block reads as cut
            off rather than as finished. */}
        <ul className="mt-5 border-b border-[var(--line-soft)]">
          {[
            `Send only ${payment.asset} on ${payment.network}. Other coins or networks are not credited automatically.`,
            'Send the full amount in one transaction where possible.',
          ].map((t) => (
            <li
              key={t}
              className="rule measure py-2.5 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
            >
              {t}
            </li>
          ))}
        </ul>
      </SheetBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// Chrome + sheet primitives
// ---------------------------------------------------------------------------

function Shell({
  children,
  merchantName,
}: {
  children: React.ReactNode;
  merchantName?: string;
}) {
  return (
    // `dvh`, never `vh`: on mobile Safari the visual viewport is shorter than
    // `100vh` while the URL bar is expanded, so a `min-h-screen` page starts
    // with a scrollbar it does not need and a footer sitting under the chrome.
    //
    // Plain ground, no depth field and no mesh. The indigo bloom that used to
    // sit behind this sheet was decoration spending the interactive colour, and
    // a calm ground is worth more here: this page has to look like a bank
    // statement, not like a landing page.
    <div className="min-h-dvh bg-[var(--ground)] px-4 py-6 sm:py-10">
      {/* ~440px and one column at EVERY width. A crypto checkout has no input
          fields to balance against a summary, so the two-column desktop layout
          a card checkout needs would buy nothing here and cost a second
          responsive surface to maintain. On a desktop this is simply a tall
          narrow sheet, which is also what it is on a phone. */}
      <div className="mx-auto w-full max-w-md">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 text-white"
              aria-hidden
            >
              <PayCrypoMark size={18} />
            </span>
            {merchantName && (
              <span className="min-w-0 leading-tight">
                <span className="runhead">Paying</span>
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

        {/* THE SHEET — one lit surface on the plain ground, plane 2 and nothing
            higher. No entrance animation: the page a stranger lands on to send
            money does not arrive from off-screen. No `.spot` either — the
            cursor-follow highlight is right on a small object a pointer rests
            on, and wrong on a region this size, where it reads as the page
            reacting to a mouse that is only passing through. */}
        <div className="surface">{children}</div>

        {/* The glyph is INLINE rather than a flex sibling: this line wraps to two
            on a narrow phone, and a flex icon centres itself against the whole
            wrapped block, leaving it stranded out to the left of a two-line
            sentence. Inline, it stays attached to the first word. */}
        <p className="mt-4 text-center text-xs text-slate-500 dark:text-slate-400">
          <ShieldCheck
            size={13}
            className="mr-1.5 inline-block align-[-2px] text-slate-400"
            aria-hidden
          />
          Secured by {BRAND_NAME} · funds go directly to the merchant
        </p>
      </div>
    </div>
  );
}

/**
 * The head of every screen: a running head on the left, the state lozenge on the
 * right, over the sheet's own hairline. Same gesture on the choose screen, the
 * pay screen, the receipt and every dead end, so the page reads as one document
 * in four states rather than as four different pages.
 *
 * It is modelled on `Section`'s header — same padding, same running head, same
 * ranged-right aside — because the merchant's dashboard is built from that
 * primitive and the checkout should not look like a different product.
 */
function SheetHead({ title, badge }: { title: string; badge?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--line-soft)] px-4 py-3.5 sm:px-6">
      {/* Wraps rather than truncates: this line carries the merchant's own title
          for the payment, and a clipped one is information lost on the screen
          that can least afford it. */}
      <span className="runhead min-w-0 break-words text-slate-700 dark:text-slate-200">
        {title}
      </span>
      {badge}
    </div>
  );
}

/** The sheet's content well. One padding decision, made once. */
function SheetBody({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-5 sm:px-6 sm:py-6">{children}</div>;
}

/**
 * ONE ENORMOUS FIGURE PER SCREEN — the amount, always.
 *
 * Deliberately NOT `.figure-xl`: that primitive scales on the VIEWPORT (up to
 * 7.5rem), which is right for a full-bleed marketing band and wrong inside a
 * 440px sheet, where a nine-digit crypto amount would run off the edge. Nor
 * `.figure-lg`, which tops out at 34px because it is drawn to fit four across a
 * dashboard stat strip; here the amount is the entire point of the page and has
 * to out-weigh everything on it.
 *
 * So the size is a clamp of its own — 32px at 360px, 44px from 640px up — and it
 * is a CLAMP rather than a pair of `text-*` utilities on purpose: a fixed
 * utility would pin the figure at one size at every width, which is the exact
 * bug this system's clamps exist to prevent.
 *
 * Tabular lining figures for the same reason they are used everywhere else money
 * is shown: proportional digits make a quantity look hand-set at the wrong
 * widths. Nothing counts up and nothing re-animates on a re-quote — the amount
 * must read as a fixed fact, not as a number in motion.
 */
function Figure({
  amount,
  unit,
  unitLeads = false,
  className = '',
}: {
  amount: string;
  unit?: string;
  /** Fiat reads "EUR 49.90"; crypto reads "53.85 USDT". */
  unitLeads?: boolean;
  className?: string;
}) {
  const u = unit ? (
    <span className="text-base font-medium text-slate-500 sm:text-lg dark:text-slate-400">
      {unit}
    </span>
  ) : null;

  return (
    <p className={`flex flex-wrap items-baseline gap-x-2.5 gap-y-1 ${className}`}>
      {unitLeads && u}
      {/* `min-w-0` + `break-words` is a safety valve, not a layout choice: it
          only engages when a figure would otherwise run off the sheet, and
          without the `min-w-0` a flex item refuses to shrink below its content
          so the break never gets the chance to fire. A number wrapped onto two
          lines can still be read in full; one clipped by the card edge cannot,
          and a digit the customer never sees is the failure this whole screen
          exists to avoid. */}
      <span className="num lining-nums min-w-0 break-words text-[clamp(2rem,1.35rem+2.9vw,2.75rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-slate-900 dark:text-slate-50">
        {amount}
      </span>
      {!unitLeads && u}
    </p>
  );
}

/** A row of the spine: label ranged left, value ranged right against one rule. */
function SpineRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // `.spine-row` puts the hairline on the ROW rather than on the two cells: a
    // rule interrupted by a column gap reads as a mistake rather than as a rule.
    <div className="spine-row">
      <dt className="spine-label">{label}</dt>
      <dd className="spine-value">{children}</dd>
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

/**
 * A dead end — not found, unavailable, expired, failed.
 *
 * `<Badge>` rather than a hand-rolled dot and word, so the checkout's states are
 * drawn by the same primitive as the merchant's ledger. Terminal tones do not
 * take `dot`, and therefore do not pulse: a blinking indicator on a page that
 * has finished would be theatre, and it would teach a payer to ignore the blink
 * where it does mean something.
 */
function DeadEnd({
  title,
  body,
  mark,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  mark: string;
  tone?: 'neutral' | 'failed';
}) {
  return (
    <>
      <SheetHead title="Checkout" badge={<Badge tone={tone}>{mark}</Badge>} />
      <SheetBody>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          {title}
        </h2>
        <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          {body}
        </p>
      </SheetBody>
    </>
  );
}

/** Drop trailing zeros from a NUMERIC(38,18) string — "18.500000…" reads badly. */
function trim(v: string): string {
  if (!v.includes('.')) return v;
  const t = v.replace(/0+$/, '').replace(/\.$/, '');
  return t || '0';
}

/**
 * mm:ss until `iso`, or null once it has passed.
 *
 * `urgent` is the last two minutes. It is returned rather than derived at the
 * call site so the threshold lives in exactly one place — the ink and the copy
 * both hang off it, and two thresholds that drift apart would put an amber
 * countdown next to a calm sentence.
 */
function useCountdownTo(iso: string): { label: string; urgent: boolean } | null {
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
  return { label: `${m}:${String(s).padStart(2, '0')}`, urgent: ms <= 120_000 };
}
