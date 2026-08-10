import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, ShieldCheck } from 'lucide-react';
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
 * SET, NOT ASSEMBLED. The inside of the frame is a statement, not a stack of
 * cards: a running head and one large figure at the top, then hairline-ruled
 * rows on a narrow-label / wide-value spine. Every rounded, bordered, tinted
 * box that used to enclose a single line of text is now a rule and some space —
 * which is also what the real screen is, once you stop drawing furniture around
 * its content.
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
 * Light text takes the 600 step, dark text the 400 step; the 500 step carries
 * neither, and slate-400 is a border/icon grey rather than a text colour.
 *
 * MOTION. The confirmation track scales rather than resizes: a width transition
 * is a layout animation on every frame, and this thing runs forever behind the
 * hero copy. transform: scaleX() with a left origin is the same picture on the
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

  return (
    // Opaque, not frosted. A screen is a screen: the glass sheen and the
    // brand-coloured bloom that used to sit behind this frame were ornament,
    // and the bloom spent the interactive colour on decoration.
    <div
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-float dark:border-slate-800 dark:bg-slate-900"
      aria-hidden
    >
      {/* Browser chrome — cheap, and it frames the mock as a real screen. */}
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="flex gap-1.5">
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
          <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
        </span>
        <span className="mx-auto flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <ShieldCheck size={11} className="text-emerald-600 dark:text-emerald-400" />
          {BRAND_CHECKOUT_HOST}
        </span>
        {/* The honesty label. It stays boxed on purpose: it is a stamp on the
            image, not a line of the document. */}
        <span className="runhead rounded-sm border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-800">
          Preview
        </span>
      </div>

      {/* The document. Opened by a rule rather than closed in a card. */}
      <div className="rule p-5 sm:p-6">
        <div className="flex items-baseline justify-between gap-4">
          <span className="runhead">Order #1042</span>
          <StatusMark phase={phase} />
        </div>

        {/* ONE FIGURE, and it is the one the customer is being asked for. */}
        <p className="mt-3 flex items-baseline gap-2">
          <span className="num lining-nums text-4xl font-semibold tracking-[-0.035em] text-slate-900 dark:text-slate-50 sm:text-[2.75rem]">
            49.90
          </span>
          <span className="text-sm font-medium text-slate-500 dark:text-slate-400">EUR</span>
        </p>
        <p className="num mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          = 53.85 USDT · rate locked
        </p>

        {/* The spine: a narrow label column against a wide value column. Naming
            asset AND network is the habit the product enforces everywhere — an
            address is only valid on the chain it was issued on. */}
        <dl className="mt-6">
          {/* The rule belongs to the ROW, not to the two cells: a hairline
              interrupted by a column gap reads as a mistake rather than as a
              rule. */}
          <div className="rule flex items-baseline gap-4 pt-3">
            <dt className="runhead w-[5.5rem] shrink-0 text-[10px]">Asset</dt>
            <dd className="min-w-0 flex-1 text-xs text-slate-900 dark:text-slate-100">
              <span className="font-medium">USDT</span>
              <span className="text-slate-500 dark:text-slate-400"> on </span>
              <span className="font-medium">TRC20</span>
            </dd>
          </div>

          <div className="rule mt-3 flex items-center gap-4 pt-3">
            <dt className="runhead w-[5.5rem] shrink-0 text-[10px]">Address</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-700 dark:text-slate-300">
                TXkExample0nly…N0tAReal4ddr
              </code>
              <Copy size={13} className="shrink-0 text-slate-400" />
            </dd>
          </div>
        </dl>

        {/* Confirmation track. The bar is the honest representation of
            "irreversible yet?" — the number alone means nothing to a merchant
            who has not read the docs. It breaks the spine deliberately: this is
            the line of the document that is actually moving. */}
        <div className="rule mt-3 pt-3">
          <div className="flex items-baseline justify-between gap-4">
            <span className="runhead text-[10px]">Confirmations</span>
            <span className="num lining-nums text-sm text-slate-500 dark:text-slate-400">
              <span className="font-medium text-slate-900 dark:text-slate-100">
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

        {/* Webhook receipt — the moment that matters to a developer.
            transition-[color] rather than transition-colors: the latter also
            animates border-color, which drags the hairline above this row into
            every phase change and every theme switch. */}
        <div
          className={`demo-step rule mt-6 flex items-center gap-2 pt-3 text-[11px] transition-[color] ${
            settled
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
          style={{ transitionDuration: 'var(--dur-set)' }}
        >
          {settled ? (
            <Check size={13} className="shrink-0" />
          ) : (
            <Loader2 size={13} className="shrink-0 animate-spin" />
          )}
          <code className="font-mono">POST /webhooks · payment.confirmed</code>
          {settled && <span className="num ml-auto font-semibold">200</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The status, set as a marginal label rather than a filled chip.
 *
 * Two carriers of meaning, never one: the word says what is happening and the
 * dot repeats it in colour for the reader who is scanning. Amber covers both
 * pre-final states — "seen but not yet yours" is still waiting — and emerald is
 * kept for the single moment the money is actually kept.
 */
function StatusMark({ phase }: { phase: Phase }) {
  const map = {
    waiting: {
      label: 'Waiting',
      text: 'text-amber-600 dark:text-amber-400',
      dot: 'bg-amber-600 dark:bg-amber-400',
    },
    confirming: {
      label: 'Confirming',
      text: 'text-amber-600 dark:text-amber-400',
      dot: 'bg-amber-600 dark:bg-amber-400',
    },
    confirmed: {
      label: 'Confirmed',
      text: 'text-emerald-600 dark:text-emerald-400',
      dot: 'bg-emerald-600 dark:bg-emerald-400',
    },
  }[phase];

  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <span className="relative flex h-1.5 w-1.5">
        {phase !== 'confirmed' && (
          <span
            className={`absolute inline-flex h-full w-full animate-pulse-ring rounded-full ${map.dot}`}
          />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${map.dot}`} />
      </span>
      <span
        className={`demo-step runhead inline-block transition-[color] ${map.text}`}
        style={{ transitionDuration: 'var(--dur-set)' }}
      >
        {map.label}
      </span>
    </span>
  );
}
