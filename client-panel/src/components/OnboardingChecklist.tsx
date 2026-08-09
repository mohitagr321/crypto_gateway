import { Link } from 'react-router-dom';
import { ArrowRight, Check, Circle, MailWarning, ShieldAlert } from 'lucide-react';
import type { OnboardingState } from '@/types';

interface Props {
  state: OnboardingState;
  /** Compact card for the dashboard; full page uses the roomier variant. */
  variant?: 'card' | 'page';
  onResendVerification?: () => void;
  resendPending?: boolean;
  resendSent?: boolean;
}

/**
 * The get-started checklist.
 *
 * Step ORDER is set by the server and mirrors what the payout path actually
 * needs — settlement wallet before API key, because a key with nowhere to settle
 * produces confirmed payments the merchant cannot withdraw. Do not reorder these
 * client-side to make the list look nicer.
 *
 * The first incomplete required step is the only one with a visible call to
 * action, so there is exactly one obvious next move at any moment.
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

  return (
    <div className={variant === 'page' ? '' : 'card p-6'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {state.complete ? "You're all set" : 'Finish setting up'}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            {state.complete
              ? 'Your account is ready to take live payments.'
              : `${state.completedRequired} of ${state.totalRequired} required steps done`}
          </p>
        </div>
        <span className="text-2xl font-bold tabular-nums text-brand-600 dark:text-brand-400">
          {pct}%
        </span>
      </div>

      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Setup progress"
      >
        <div
          className="h-full rounded-full bg-brand-600 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      {state.warnings.simpleKeyWithoutIpAllowlist && (
        <div className="mt-5 flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
          <ShieldAlert size={15} className="mt-0.5 shrink-0" />
          <span>
            You have a bearer-token API key with no IP allowlist. That token is
            usable from anywhere it leaks.{' '}
            <Link to="/settings" className="font-semibold underline">
              Restrict it to your server's IP
            </Link>
            .
          </span>
        </div>
      )}

      <ol className="mt-6 space-y-1">
        {state.steps.map((step) => {
          const isNext = nextStep?.id === step.id;
          return (
            <li
              key={step.id}
              className={`flex gap-3.5 rounded-xl p-3.5 transition ${
                isNext ? 'bg-brand-50/70 dark:bg-brand-900/15' : ''
              }`}
            >
              <span className="mt-0.5 shrink-0">
                {step.done ? (
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white">
                    <Check size={14} strokeWidth={3} />
                  </span>
                ) : (
                  <Circle
                    size={24}
                    className={isNext ? 'text-brand-500' : 'text-slate-300 dark:text-slate-700'}
                  />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm font-semibold ${
                    step.done
                      ? 'text-slate-400 line-through dark:text-slate-600'
                      : 'text-slate-900 dark:text-slate-100'
                  }`}
                >
                  {step.title}
                  {!step.required && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      optional
                    </span>
                  )}
                </span>
                {!step.done && (
                  <span className="mt-1 block text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {step.description}
                  </span>
                )}

                {/* Verification is the one step with no page to visit — the
                    action is in the merchant's inbox, so offer a resend. */}
                {!step.done && step.id === 'verify_email' && onResendVerification && (
                  <span className="mt-3 block">
                    {resendSent ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 dark:text-brand-300">
                        <Check size={14} /> Sent — check your inbox and spam folder.
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
                  </span>
                )}

                {!step.done && step.href && isNext && (
                  <Link to={step.href} className="btn-primary mt-3 inline-flex text-sm">
                    {step.title} <ArrowRight size={15} />
                  </Link>
                )}
                {!step.done && step.href && !isNext && (
                  <Link
                    to={step.href}
                    className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    Go <ArrowRight size={13} />
                  </Link>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
