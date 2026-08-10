import { Check, Circle, X } from 'lucide-react';
import type { Payment, PaymentStatus } from '@/types';
import { formatDate } from '@/lib/format';

interface Step {
  key: PaymentStatus;
  label: string;
  description: string;
}

const HAPPY_PATH: Step[] = [
  { key: 'waiting', label: 'Waiting', description: 'Awaiting USDT deposit' },
  { key: 'confirming', label: 'Confirming', description: 'Transaction seen, gathering confirmations' },
  { key: 'confirmed', label: 'Confirmed', description: 'Enough confirmations reached' },
  { key: 'swept', label: 'Swept', description: 'Funds moved to collection wallet' },
];

const ORDER: PaymentStatus[] = ['waiting', 'confirming', 'confirmed', 'swept'];

/**
 * THE INK ON THIS COMPONENT IS STATE INK, NEVER BRAND.
 *
 * The markers used to be `bg-brand-500` and the current step's label
 * `text-brand-600` — the CTA colour spent on a payment status readout, on the
 * two dashboard routes (`/payments/new`, `/payments/:id`) where a merchant
 * reads whether their money has arrived. Brand means "this is the thing you can
 * click"; it never indicates state.
 *
 * The mapping mirrors `paymentTone` in Badge.tsx exactly, because the badge for
 * this same payment sits directly above this timeline and the two must never
 * disagree about which green means what:
 *
 *   emerald  the stage was reached      amber  still waiting on it
 *   red      it failed                  slate  not reached yet
 *
 * COLOUR IS NOT THE SOLE CARRIER at any step. A reached stage carries a tick, an
 * unreached one a hollow circle, and the step the payment is actually sitting on
 * is named in words ("current") as well as marked with `aria-current`.
 */
type StageTone = 'settled' | 'waiting' | 'todo';

const MARKER_INK: Record<StageTone, string> = {
  settled: 'bg-emerald-600 text-white dark:bg-emerald-400 dark:text-slate-950',
  waiting: 'bg-amber-600 text-white dark:bg-amber-400 dark:text-slate-950',
  todo: 'bg-slate-200 text-slate-400 dark:bg-slate-700',
};

const LABEL_INK: Record<StageTone, string> = {
  settled: 'text-emerald-700 dark:text-emerald-400',
  waiting: 'text-amber-700 dark:text-amber-400',
  todo: 'text-slate-400',
};

export default function PaymentTimeline({ payment }: { payment: Payment }) {
  const isFailure =
    payment.status === 'failed' ||
    payment.status === 'expired' ||
    payment.status === 'partial';

  const currentIndex = ORDER.indexOf(payment.status);

  // `confirmed` and `swept` are the two states where the money has actually
  // landed — the same call Badge.tsx makes, for the same reason.
  const landed = payment.status === 'confirmed' || payment.status === 'swept';

  return (
    <div>
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Timeline
      </h4>
      <ol className="relative space-y-4 border-l border-slate-200 pl-5 dark:border-slate-700">
        {HAPPY_PATH.map((step, i) => {
          const done = !isFailure && currentIndex >= i && currentIndex !== -1;
          const active = !isFailure && currentIndex === i;

          // A stage BEHIND the current one was passed, so the payment did get
          // that far: emerald. The stage it is sitting on takes the tone of the
          // payment itself — emerald once the funds have landed, amber while
          // something is still owed.
          const tone: StageTone = !done ? 'todo' : active && !landed ? 'waiting' : 'settled';

          return (
            <li key={step.key} className="relative">
              <span
                className={`absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white dark:ring-slate-900 ${MARKER_INK[tone]}`}
              >
                {done ? <Check size={10} /> : <Circle size={6} />}
              </span>
              <p
                className={`text-sm font-medium ${
                  active
                    ? LABEL_INK[tone]
                    : done
                      ? 'text-slate-700 dark:text-slate-200'
                      : LABEL_INK.todo
                }`}
                aria-current={active ? 'step' : undefined}
              >
                {step.label}
                {/* The word, so the step the payment is actually on is not
                    identified by hue alone. */}
                {active && (
                  <span className="ml-2 text-xs font-normal uppercase tracking-[0.1em]">
                    current
                  </span>
                )}
                {i === 0 && payment.createdAt && (
                  <span className="ml-2 font-normal text-xs text-slate-400">
                    {formatDate(payment.createdAt)}
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-400">{step.description}</p>
            </li>
          );
        })}

        {isFailure && (
          <li className="relative">
            {/* 600 in light, 400 in dark, like every other marker above. The
                500 step is the one the ramp does NOT correct, so a stock
                red-500 disc sat visibly off the corrected reds beside it. */}
            <span className="absolute -left-[27px] flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white ring-4 ring-white dark:bg-red-400 dark:text-slate-950 dark:ring-slate-900">
              <X size={10} />
            </span>
            <p className="text-sm font-medium capitalize text-red-600 dark:text-red-400">
              {payment.status}
            </p>
            <p className="text-xs text-slate-400">
              {payment.status === 'expired'
                ? 'Payment window elapsed without full payment.'
                : payment.status === 'partial'
                  ? 'Received less than the requested amount.'
                  : 'Payment failed or was reversed by a reorg.'}
            </p>
          </li>
        )}
      </ol>
    </div>
  );
}
