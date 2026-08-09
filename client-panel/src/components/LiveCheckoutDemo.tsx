import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, ShieldCheck, Wallet } from 'lucide-react';

/**
 * The hero's centrepiece: a replica of the real hosted checkout, playing the
 * payment lifecycle on a loop.
 *
 * WHY A REPLICA AND NOT THE ABSTRACT DIAGRAM IT REPLACES
 * The previous hero was labelled boxes joined by dashed lines — an illustration
 * OF the product rather than the product. A merchant evaluating a gateway wants
 * to know what their customer will actually see, and the single strongest signal
 * a payments site can send is "here is the screen, it looks trustworthy". The
 * layout, type scale and status colours below deliberately mirror
 * pages/public/Checkout.tsx.
 *
 * IT IS A MOCK, AND IT SAYS SO. The address is not a real address and no request
 * is made. A hero that faked live network data would be a lie told to a
 * prospective customer about money, so the frame is labelled "Preview" and the
 * address is visibly a placeholder rather than a plausible-looking real one.
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

  return (
    <div className="relative" aria-hidden>
      {/* Glow tethered to the card, so the card reads as the light source. */}
      <div
        className="absolute -inset-8 -z-10 rounded-[3rem] bg-gradient-to-br from-brand-500/25 via-accent-500/15 to-transparent blur-2xl"
      />

      <div className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-white/90 shadow-float backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/80">
        {/* Specular sweep. Sits above the surface, below the content. */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="animate-sheen absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent dark:via-white/10" />
        </div>

        {/* Browser chrome — cheap, and it frames the mock as a real screen. */}
        <div className="relative flex items-center gap-2 border-b border-slate-200/70 px-4 py-3 dark:border-white/10">
          <span className="flex gap-1.5">
            <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
            <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
            <i className="h-2.5 w-2.5 rounded-full bg-slate-300 dark:bg-slate-700" />
          </span>
          <span className="mx-auto flex items-center gap-1.5 rounded-md bg-slate-100 px-2.5 py-1 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <ShieldCheck size={11} className="text-emerald-500" />
            pay.securipay.io
          </span>
          <span className="rounded-md border border-slate-200 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-400 dark:border-slate-700">
            Preview
          </span>
        </div>

        <div className="relative p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-medium text-slate-400">Order #1042</p>
              <p className="mt-1 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold tracking-tight text-slate-900 num dark:text-slate-50 sm:text-3xl">
                  49.90
                </span>
                <span className="text-sm font-medium text-slate-400">EUR</span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-400 num">
                = 53.85 USDT · rate locked
              </p>
            </div>
            <StatusPill phase={phase} />
          </div>

          {/* Asset + network. Naming both is the habit the product enforces
              everywhere — an address is only valid on the chain it was issued on. */}
          <div className="mt-5 flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              USDT
            </span>
            <span className="text-slate-300 dark:text-slate-600">on</span>
            <span className="rounded-lg bg-slate-100 px-2 py-1 font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              TRC20
            </span>
          </div>

          {/* Deposit address */}
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2.5 dark:border-slate-700/70 dark:bg-slate-800/50">
            <Wallet size={14} className="shrink-0 text-slate-400" />
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300">
              TXkExample0nly…N0tAReal4ddr
            </code>
            <Copy size={13} className="shrink-0 text-slate-400" />
          </div>

          {/* Confirmation track. The bar is the honest representation of
              "irreversible yet?" — the number alone means nothing to a merchant
              who has not read the docs. */}
          <div className="mt-5">
            <div className="mb-1.5 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">Confirmations</span>
              <span className="font-medium text-slate-500 num dark:text-slate-400">
                {confirmations} / {CONFIRMS_REQUIRED}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700/70">
              <div
                className={`demo-step h-full rounded-full transition-all duration-500 ease-out ${
                  phase === 'confirmed' ? 'bg-emerald-500' : 'bg-brand-500'
                }`}
                style={{ width: `${(confirmations / CONFIRMS_REQUIRED) * 100}%` }}
              />
            </div>
          </div>

          {/* Webhook receipt — the moment that matters to a developer. */}
          <div
            className={`demo-step mt-4 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-[11px] transition-all duration-500 ${
              phase === 'confirmed'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-slate-200 bg-slate-50/70 text-slate-400 dark:border-slate-700/70 dark:bg-slate-800/50'
            }`}
          >
            {phase === 'confirmed' ? (
              <Check size={13} className="shrink-0" />
            ) : (
              <Loader2 size={13} className="shrink-0 animate-spin" />
            )}
            <code className="font-mono">
              POST /webhooks · payment.confirmed
            </code>
            {phase === 'confirmed' && (
              <span className="ml-auto font-semibold num">200</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ phase }: { phase: Phase }) {
  const map = {
    waiting: {
      label: 'Waiting',
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      dot: 'bg-amber-500',
    },
    confirming: {
      label: 'Confirming',
      cls: 'bg-brand-100 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300',
      dot: 'bg-brand-500',
    },
    confirmed: {
      label: 'Confirmed',
      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
      dot: 'bg-emerald-500',
    },
  }[phase];

  return (
    <span
      className={`demo-step inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors duration-500 ${map.cls}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {phase !== 'confirmed' && (
          <span className={`absolute inline-flex h-full w-full animate-pulse-ring rounded-full ${map.dot}`} />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${map.dot}`} />
      </span>
      {map.label}
    </span>
  );
}
