import { useEffect, useRef, useState } from 'react';
import { Check, Clock, Copy, ShieldCheck } from 'lucide-react';
import Badge from '@/components/Badge';
import { BRAND_CHECKOUT_HOST } from '@/lib/brand';

/**
 * The hero's centrepiece: a replica of the real hosted checkout, playing the
 * payment lifecycle on a loop.
 *
 * WHY A REPLICA AND NOT THE ABSTRACT DIAGRAM IT REPLACES
 * The previous hero was labelled boxes joined by dashed lines — an illustration
 * OF the product rather than the product. A merchant evaluating a gateway wants
 * to know what their customer will actually see, and the single strongest signal
 * a payments site can send is "here is the screen, it looks trustworthy".
 *
 * IT MUST NOT DRIFT FROM pages/public/Checkout.tsx, AND THAT IS THE WHOLE POINT.
 * A replica that has quietly diverged is worse than no replica: it is a promise
 * about what the payer sees that the product no longer keeps. Every element
 * shared with the real screen is built from the same classes here as there —
 * the head and its status lozenge, the amount's clamp, the `.well` payment
 * panel with the network on its own top strip, the spine, the confirmation
 * track. If you change one file, change the other in the same commit.
 *
 * WHAT IT DELIBERATELY OMITS is the QR and the working copy control. A
 * scannable QR encoding a placeholder address, sitting on a marketing page, is
 * a thing a curious visitor will point a wallet at and get an error from — so
 * the panel keeps its shape and its labels and shows the address alone. This is
 * a crop of the real screen, not a clone of it.
 *
 * IT IS A MOCK, AND IT SAYS SO. The address is not a real address and no request
 * is made. A hero that faked live network data would be a lie told to a
 * prospective customer about money, so the frame is labelled "Preview" and the
 * address is visibly a placeholder rather than a plausible-looking real one.
 *
 * COLOUR. Brand is interactive-only and appears nowhere in here, because nothing
 * in here can be clicked. The status previously ran waiting(amber) ->
 * confirming(BRAND) -> confirmed(emerald), which spent the CTA colour on a
 * payment state and broke the one rule the palette exists to enforce. Confirming
 * is amber: the money has been seen but not yet kept, which is the same
 * "waiting on something" amber already means. Waiting and confirming are then
 * told apart by the WORD and by the confirmation track, never by hue alone.
 *
 * MOTION. It spends the same three-animation budget the real checkout does, and
 * on the same three things: the live lozenge's halo (`<Badge dot>`, the one loop
 * this design permits product-wide), the confirmation track, and the settle on a
 * status change. The `Loader2` that used to spin on the webhook row is gone —
 * there is no spinner on the real checkout, so there is none here; a static dot
 * plus a word carries "not yet" without implying a hung request.
 *
 * The track SCALES rather than resizes: a width transition is a layout animation
 * on every frame, and this thing runs forever behind the hero copy.
 * `transform: scaleX()` with a left origin is the same picture on the
 * compositor.
 *
 * ACCESSIBILITY. The whole thing is aria-hidden: it is decorative, and a screen
 * reader announcing a fake payment progressing would be actively confusing. The
 * surrounding section carries the real text. It also honours
 * prefers-reduced-motion by holding on the settled state instead of cycling.
 */

type Phase = 'waiting' | 'confirming' | 'confirmed';

const PHASES: { key: Phase; ms: number }[] = [
  { key: 'waiting', ms: 2600 },
  { key: 'confirming', ms: 3200 },
  { key: 'confirmed', ms: 3400 },
];

const CONFIRMS_REQUIRED = 12;

/**
 * Placeholder, and visibly one — but 34 characters, the real length of a Tron
 * address. The length is the part that has to be honest: it is what decides
 * that the address wraps onto two lines here exactly as it does on the live
 * screen, and a short mock would quietly promise a one-line address.
 */
const DEMO_ADDRESS = 'TXkExample0nlyN0tAReal4ddre55Xy9Qk';

export default function LiveCheckoutDemo() {
  const [phase, setPhase] = useState<Phase>('waiting');
  const [confirmations, setConfirmations] = useState(0);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Reduced motion: show the end state and stop. The information is the
    // point; the cycling is the decoration.
    if (reduced.current) {
      setPhase('confirmed');
      setConfirmations(CONFIRMS_REQUIRED);
      return;
    }

    let i = 0;
    let timer: number;
    const advance = () => {
      const current = PHASES[i % PHASES.length];
      setPhase(current.key);
      setConfirmations(
        current.key === 'waiting' ? 0 : current.key === 'confirmed' ? CONFIRMS_REQUIRED : 0,
      );
      i += 1;
      timer = window.setTimeout(advance, current.ms);
    };
    advance();
    return () => window.clearTimeout(timer);
  }, []);

  // Count confirmations up during the confirming phase so the number moves like
  // a real chain watcher rather than snapping.
  useEffect(() => {
    if (phase !== 'confirming' || reduced.current) return;
    const id = window.setInterval(() => {
      setConfirmations((c) => (c >= CONFIRMS_REQUIRED - 1 ? c : c + 1));
    }, 240);
    return () => window.clearInterval(id);
  }, [phase]);

  const settled = phase === 'confirmed';
  const confirming = phase === 'confirming';

  return (
    // The same `.surface` the real sheet is built from, at plane 2. Not glass
    // and not `shadow-float`: this is a picture of a screen, not a floating
    // panel, and the elevation law puts heavy shadows on chrome and modals only.
    // `overflow-hidden` is what clips the browser bar's fill to the radius.
    <div className="surface overflow-hidden" aria-hidden>
      {/* Browser chrome — cheap, and it frames the mock as a real screen. */}
      <div className="flex items-center gap-2 border-b border-[var(--line-soft)] bg-[var(--surface-2)] px-4 py-3">
        <span className="flex gap-1.5">
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
        </span>
        <span className="mx-auto flex min-w-0 items-center gap-1.5 rounded-md bg-[var(--surface)] px-2.5 py-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">
          <ShieldCheck size={11} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span className="truncate">{BRAND_CHECKOUT_HOST}</span>
        </span>
        {/* The honesty label. It stays boxed on purpose: it is a stamp on the
            image, not a line of the document. */}
        <span className="runhead shrink-0 rounded-sm border border-[var(--line)] px-1.5 py-0.5">
          Preview
        </span>
      </div>

      {/* THE HEAD — the real sheet's head, same padding, same running head, same
          ranged-right lozenge. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-[var(--line-soft)] px-4 py-3.5 sm:px-6">
        <span className="runhead min-w-0 break-words text-slate-700 dark:text-slate-200">
          Send payment
        </span>
        <Badge tone={settled ? 'settled' : 'waiting'} dot>
          {settled ? 'Confirmed' : confirming ? 'Confirming' : 'Waiting'}
        </Badge>
      </div>

      <div className="px-4 py-5 sm:px-6 sm:py-6">
        {/* ONE FIGURE, and it is the CRYPTO amount — which is what the real pay
            screen leads with once a quote is locked. Leading with the fiat
            figure here (as this mock used to) put the merchant's currency at the
            top of a screen whose whole job is to get one crypto number sent
            correctly, and that is drift of exactly the kind this file exists to
            prevent. Same clamp as the real figure: 32px at 360px, 44px from
            640px up. */}
        <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="num lining-nums min-w-0 break-words text-[clamp(2rem,1.35rem+2.9vw,2.75rem)] font-semibold leading-[0.98] tracking-[-0.04em] text-slate-900 dark:text-slate-50">
            53.85
          </span>
          <span className="text-base font-medium text-slate-500 sm:text-lg dark:text-slate-400">
            USDT
          </span>
        </p>
        <p className="num mt-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          EUR 49.90 at 0.9266 EUR/USDT · held for this payment
        </p>

        {/* The countdown, in the same place and the same ink as the real one.
            No depleting ring and no pulse — panic devices on a money page
            convert to abandonment rather than to urgency. */}
        <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
          <Clock size={14} className="shrink-0" />
          Expires in <span className="num lining-nums font-semibold tabular-nums">12:04</span>
        </p>

        {/* The pair, in ink rather than in a coloured pill: amber and red mean
            states on this screen, and this is an instruction, not a state. */}
        <p className="measure mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Send <strong className="font-semibold text-slate-900 dark:text-slate-50">USDT</strong> on
          the <strong className="font-semibold text-slate-900 dark:text-slate-50">TRC20</strong>{' '}
          network only. This address accepts nothing else.
        </p>

        {/* THE PAYMENT PANEL — `.well`, the inset surface, exactly as on the
            real screen. Visually encasing the sensitive block is the strongest
            single lever on perceived security, and it is the only container the
            sheet has, so the encasing means something. The network sits on its
            top strip because it is part of the address's IDENTITY: an address is
            only valid on the chain it was issued on, and a payer scanning for
            "TRC20" finds it attached to the thing they are about to copy rather
            than in a banner they have already learned to skip. */}
        <div className="well mt-5 p-3 sm:p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="runhead">Payment address</span>
            <span className="text-xs font-semibold text-slate-900 dark:text-slate-50">
              USDT · TRC20
            </span>
          </div>

          {/* 16px mono, broken on characters, never truncated. The
              `0x71C7…976F` abbreviation every wallet UI uses is the exact
              pattern address-poisoning attacks are built to defeat, so the real
              screen shows the whole string and so does the replica. */}
          <code className="mt-3 block break-all font-mono text-base leading-relaxed text-slate-900 dark:text-slate-50">
            {DEMO_ADDRESS}
          </code>

          {/* The copy control, at the width and weight it has on the real
              screen. Inert here — the whole frame is decorative — but it is the
              primary path on the live page, so leaving it as a corner icon
              would misrepresent the screen. */}
          <span className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm font-semibold text-slate-900 shadow-soft dark:text-slate-100">
            <Copy size={16} className="shrink-0" />
            Copy address
          </span>
        </div>

        {/* Status, then the confirmation track under it — the same block, in the
            same order, as the real screen. The line is the reason there is no
            spinner: it says what is happening, which an indeterminate glyph
            never does.

            THE REAL SCREEN CARRIES A SECOND, EXPLANATORY SENTENCE UNDER THIS
            ONE and this replica deliberately does not, which is the only place
            the two are allowed to differ. That sentence is a different length
            in each phase, so on a looping mock it would reflow the frame every
            few seconds — and a hero that changes height on its own is the
            layout shift this design bans outright. The three headlines above
            all set on ONE line at this width, which is what keeps the frame a
            fixed height through the whole cycle. Check that again if you ever
            edit their wording. */}
        <div className="rule mt-5 pt-4">
          <p
            className="demo-step text-sm font-semibold text-slate-900 transition-[color] dark:text-slate-100"
            style={{ transitionDuration: 'var(--dur-set)' }}
          >
            {settled
              ? 'Payment received'
              : confirming
                ? 'Payment detected — confirming on-chain'
                : 'Waiting for your payment'}
          </p>

          {/* Confirmation track. The bar is the honest representation of
              "irreversible yet?" — the number alone means nothing to a merchant
              who has not read the docs. Determinate, which is the whole reason
              it is allowed where a spinner is not. */}
          <div className="mt-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="runhead">Confirmations</span>
              <span className="num lining-nums text-sm text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {confirmations}
                </span>
                {' / '}
                {CONFIRMS_REQUIRED}
              </span>
            </div>
            {/* A rule that fills in, rather than a bar that grows. Square ends:
                scaleX() on a rounded cap stretches it into an oval. */}
            <div className="mt-2 h-[3px] w-full overflow-hidden bg-slate-200 dark:bg-slate-800">
              <div
                className={`demo-step h-full w-full origin-left transition-transform ${
                  settled ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-amber-600 dark:bg-amber-400'
                }`}
                style={{
                  transform: `scaleX(${confirmations / CONFIRMS_REQUIRED})`,
                  transitionDuration: 'var(--dur-set)',
                  transitionTimingFunction: 'var(--ease-out)',
                }}
              />
            </div>
          </div>
        </div>

        {/* Webhook receipt — the moment that matters to a developer, and the one
            line of this mock that is aimed at the merchant rather than at their
            customer.

            NO SPINNER. The real checkout has none, so neither does its replica:
            a static dot plus the unfilled 200 says "not yet" without implying a
            request that has hung. `transition-[color]` rather than
            `transition-colors`: the latter also animates border-color, which
            drags the hairline above this row into every phase change and every
            theme switch. */}
        <div
          className={`demo-step rule mt-5 flex items-center gap-2 pt-3 text-xs transition-[color] ${
            settled
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
          style={{ transitionDuration: 'var(--dur-set)' }}
        >
          {settled ? (
            <Check size={13} className="shrink-0" />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400 dark:bg-slate-500" />
          )}
          <code className="min-w-0 truncate font-mono">POST /webhooks · payment.confirmed</code>
          {settled && <span className="num ml-auto shrink-0 font-semibold">200</span>}
        </div>
      </div>
    </div>
  );
}
