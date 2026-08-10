import { Link } from 'react-router-dom';
import { ArrowRight, Check, MailWarning, ShieldAlert } from 'lucide-react';
import type { OnboardingState } from '@/types';

interface Props {
  state: OnboardingState;
  /** Compact for the dashboard; the full page uses the roomier variant. */
  variant?: 'card' | 'page';
  onResendVerification?: () => void;
  resendPending?: boolean;
  resendSent?: boolean;
}

/**
 * The get-started checklist, set as a RULED LIST.
 *
 * Step ORDER is set by the server and mirrors what the payout path actually
 * needs — settlement wallet before API key, because a key with nowhere to settle
 * produces confirmed payments the merchant cannot withdraw. Do not reorder these
 * client-side to make the list look nicer.
 *
 * The first incomplete required step is the only one with a visible call to
 * action, so there is exactly one obvious next move at any moment. It is marked
 * by the word NEXT in the margin rather than by a tinted band: a tint is a box,
 * and a box is what this list is not.
 *
 * TWO CARRIERS ON EVERY STATE. A completed step is emerald AND struck through
 * AND says "done"; the next step is ink AND labelled. Nothing here relies on
 * colour alone, which also means it survives a greyscale print of the page.
 */
export default function OnboardingChecklist({
  state,
  variant = 'card',
  onResendVerification,
  resendPending,
  resendSent,
}: Props) {
  const nextStep = state.steps.find((s) => s.required && !s.done);
  const pct = Math.round((state.completedRequired / state.totalRequired) * 100);
  const roomy = variant === 'page';

  return (
    <div>
      {/* The masthead of the block: running head, statement, and the figure
          ranged right against it. */}
      <div className="rule flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-3">
        <div className="min-w-0">
          <span className="runhead">Setup</span>
          <h2
            className={`mt-1.5 font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-50 ${
              roomy ? 'text-xl' : 'text-base'
            }`}
          >
            {state.complete ? "You're all set" : 'Finish setting up'}
          </h2>
          <p className="measure mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {state.complete
              ? 'Your account is ready to take live payments.'
              : `${state.completedRequired} of ${state.totalRequired} required steps done. The rest can wait.`}
          </p>
        </div>

        {/* Ink, not brand. The percentage is a STATE — how far through setup you
            are — and brand only ever means "something you can click". */}
        <p className="figure-lg shrink-0 text-3xl">{pct}%</p>
      </div>

      <div
        className="mt-3 h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Setup progress"
      >
        {/* scaleX, not width: a width transition is a layout animation and is
            banned. Brand IS correct on the bar — it measures a task you can act
            on, not the state of a payment.
            The transition only ever runs when `pct` CHANGES; on mount React
            renders the final transform, so there is no entrance animation. The
            duration is the shared token, inside the dashboard's 200ms budget —
            it used to be 500ms, which is over it. */}
        <div
          className="h-full w-full origin-left bg-brand-600 transition-transform duration-[var(--dur-pop)] ease-[var(--ease-out)]"
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, pct / 100))})` }}
        />
      </div>

      {state.warnings.simpleKeyWithoutIpAllowlist && (
        // A ruled note, not an amber panel. Amber is right — this is waiting on
        // the merchant to act, not a failure — but it belongs in the INK and the
        // running head, where it does not shout over the list it sits above.
        <div className="rule mt-6 flex gap-3 pt-3">
          <ShieldAlert
            size={15}
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="min-w-0">
            <span className="runhead text-amber-600 dark:text-amber-400">
              Unrestricted key
            </span>
            <p className="measure mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              You have a bearer-token API key with no IP allowlist. That token is
              usable from anywhere it leaks.{' '}
              <Link to="/settings" className="link-ink">
                Restrict it to your server's IP
              </Link>
              .
            </p>
          </div>
        </div>
      )}

      <ol className="mt-6">
        {state.steps.map((step, i) => {
          const isNext = nextStep?.id === step.id;
          return (
            <li
              key={step.id}
              className={`rule grid grid-cols-[2.5rem_1fr] gap-x-3 ${roomy ? 'py-4' : 'py-3'}`}
            >
              {/* The margin column: a two-digit ordinal, tabular so the rules
                  line up, and the one word that says where you are. */}
              <span className="pt-0.5">
                <span
                  className={`runhead num ${
                    step.done
                      ? 'text-slate-400 dark:text-slate-600'
                      : isNext
                        ? 'text-slate-900 dark:text-slate-100'
                        : ''
                  }`}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {isNext && (
                  <span className="runhead mt-1 text-slate-900 dark:text-slate-100">
                    Next
                  </span>
                )}
              </span>

              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3
                    className={`text-sm font-semibold ${
                      step.done
                        ? 'text-slate-400 line-through dark:text-slate-600'
                        : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {step.title}
                    {!step.required && (
                      <span className="ml-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                        optional
                      </span>
                    )}
                  </h3>

                  {step.done && (
                    // emerald = verified and healthy. Brand used to fill this
                    // disc, which made "done" the same colour as "the button you
                    // should press".
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium uppercase tracking-[0.1em] text-emerald-600 dark:text-emerald-400">
                      <Check size={13} strokeWidth={3} aria-hidden />
                      done
                    </span>
                  )}
                </div>

                {!step.done && (
                  <p className="measure mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {step.description}
                  </p>
                )}

                {/* Verification is the one step with no page to visit — the
                    action is in the merchant's inbox, so offer a resend. */}
                {!step.done && step.id === 'verify_email' && onResendVerification && (
                  <div className="mt-3">
                    {resendSent ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                        <Check size={14} aria-hidden /> Sent — check your inbox and spam
                        folder.
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={onResendVerification}
                        disabled={resendPending}
                        className="btn-secondary text-sm"
                      >
                        <MailWarning size={15} /> Resend confirmation email
                      </button>
                    )}
                  </div>
                )}

                {!step.done && step.href && isNext && (
                  <Link to={step.href} className="btn-primary mt-3 inline-flex text-sm">
                    {step.title} <ArrowRight size={15} />
                  </Link>
                )}
                {!step.done && step.href && !isNext && (
                  <Link to={step.href} className="link-ink mt-2 inline-flex items-center gap-1 text-sm">
                    Go <ArrowRight size={13} aria-hidden />
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
