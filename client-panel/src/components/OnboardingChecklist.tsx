import { Link } from 'react-router-dom';
import { ArrowRight, Check, MailWarning, ShieldAlert } from 'lucide-react';
import type { OnboardingState } from '@/types';
import Section from '@/components/Section';

interface Props {
  state: OnboardingState;
  /** Compact for the dashboard; the full page uses the roomier variant. */
  variant?: 'card' | 'page';
  onResendVerification?: () => void;
  resendPending?: boolean;
  resendSent?: boolean;
}

/**
 * The get-started checklist, ON ITS OWN SURFACE.
 *
 * IT OWNS ITS SURFACE, AND BOTH CALL SITES DEPEND ON THAT. Dashboard renders it
 * bare under the page header and the Onboarding page renders it bare in a grid
 * column — neither wraps it — so as a stack of hairlines printed on the canvas
 * it was the one flat thing on a page otherwise built from lit surfaces, which
 * reads as an unfinished region rather than as a restrained one. It renders a
 * `Section` for exactly the reason every other block does, which also means the
 * running head, the padding and the rhythm come from the same place as the rest
 * of the page instead of being respelled here. Do NOT wrap this in a second
 * `Section` at a call site.
 *
 * Step ORDER is set by the server and mirrors what the payout path actually
 * needs — settlement wallet before API key, because a key with nowhere to settle
 * produces confirmed payments the merchant cannot withdraw. Do not reorder these
 * client-side to make the list look nicer.
 *
 * The first incomplete required step is the only one with a visible call to
 * action, so there is exactly one obvious next move at any moment. It is marked
 * by the word NEXT in the margin rather than by a tinted band: a tint is a box,
 * and the boxes on this page are the surfaces, not the rows inside one.
 *
 * TWO CARRIERS ON EVERY STATE. A completed step is emerald AND struck through
 * AND says "done"; the next step is ink AND labelled. Nothing here relies on
 * colour alone, which also means it survives a greyscale print of the page.
 *
 * RULES ARE STILL RIGHT INSIDE THIS ONE. The redesign replaced rules doing
 * STRUCTURAL work — a stack of bands standing in for a page — with surfaces. A
 * checklist is a list of like things read in order down a single block, which
 * is precisely the case a hairline is for: it divides WITHIN a surface rather
 * than pretending to be one.
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
  // Every step that is not the one being shown expanded on a phone.
  const remaining = state.steps.filter((st) => !st.done && st.id !== nextStep?.id).length;
  const roomy = variant === 'page';

  return (
    <Section title="Setup">
      {/* The statement and the figure ranged against each other. The figure
          carries NO size utility: `.figure-lg` is a fluid clamp, and the
          `text-3xl` that used to sit here pinned it to 30px at every width,
          which is the exact way a clamp gets silently defeated. */}
      <div className="flex flex-nowrap items-end justify-between gap-x-4 sm:gap-x-6">
        <div className="min-w-0">
          <h3
            className={`font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-50 ${
              roomy ? 'text-xl' : 'text-base'
            }`}
          >
            {state.complete ? "You're all set" : 'Finish setting up'}
          </h3>
          <p className="measure mt-1 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            {state.complete
              ? 'Your account is ready to take live payments.'
              : `${state.completedRequired} of ${state.totalRequired} required steps done. The rest can wait.`}
          </p>
        </div>

        {/* Ink, not brand. The percentage is a STATE — how far through setup you
            are — and brand only ever means "something you can click". */}
        <p className="figure-lg shrink-0">{pct}%</p>
      </div>

      <div
        className="mt-3 h-1 overflow-hidden rounded-full bg-[var(--line)]"
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
          className="h-full w-full origin-left bg-brand-600 transition-transform duration-[var(--dur-pop)] ease-[var(--ease-out)] dark:bg-brand-400"
          style={{ transform: `scaleX(${Math.min(1, Math.max(0, pct / 100))})` }}
        />
      </div>

      {state.warnings.simpleKeyWithoutIpAllowlist && (
        // A ruled note, not an amber panel. Amber is right — this is waiting on
        // the merchant to act, not a failure — but it belongs in the INK and the
        // running head, where it does not shout over the list it sits above.
        <div className="rule mt-4 flex gap-3 pt-3 sm:mt-6">
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

      <ol className="mt-4 sm:mt-6">
        {state.steps.map((step, i) => {
          const isNext = nextStep?.id === step.id;
          return (
            <li
              key={step.id}
              /* ON A PHONE, THE DASHBOARD EMBED SHOWS ONLY THE STEP YOU ARE ON.
                 The full list is 663px on a 320px screen — most of a viewport
                 spent on setup, above the figures the merchant opened the page
                 for. Below `sm` the other rows are dropped and replaced by the
                 one-line summary underneath; from `sm` the whole list is back,
                 because a desktop dashboard has the room and the overview is
                 worth having. The /onboarding page (`roomy`) is never
                 collapsed — showing every step IS that page's job.
                 `hidden` rather than unmounting: the list stays complete for a
                 screen reader and for anyone who rotates to a wider viewport. */
              className={`rule grid grid-cols-[1.75rem_1fr] gap-x-2.5 sm:grid-cols-[2.5rem_1fr] sm:gap-x-3 ${
                roomy ? 'py-3.5 sm:py-4' : 'py-2.5 sm:py-3'
              } ${!roomy && !isNext ? 'max-sm:hidden' : ''}`}
            >
              {/* The margin column: a two-digit ordinal, tabular so the rules
                  line up, and the one word that says where you are. Only the
                  NEXT step's ordinal takes ink — a completed one used to be
                  painted slate-400, which is the step this ramp reserves for
                  borders and decorative marks and never lets carry text on the
                  light ground. The strike-through and the word "done" already
                  say the row is finished. */}
              <span className="pt-0.5">
                <span
                  className={`runhead num ${
                    isNext ? 'text-slate-900 dark:text-slate-100' : ''
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
                  <h4
                    className={`text-sm font-semibold ${
                      step.done
                        ? 'text-slate-500 line-through dark:text-slate-400'
                        : 'text-slate-900 dark:text-slate-100'
                    }`}
                  >
                    {step.title}
                    {!step.required && (
                      <span className="ml-2 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                        optional
                      </span>
                    )}
                  </h4>

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

                {/* THE DESCRIPTION IS FOR THE STEP YOU ARE ON.
                    On the /onboarding page (`roomy`) every incomplete step
                    explains itself, because explaining them is what that page
                    is for. On the DASHBOARD embed only the next one does:
                    four paragraphs of instructions for steps the merchant
                    cannot act on yet cost 787px on a 375px screen — more than
                    a full viewport, sitting above the figures they actually
                    opened the page to read. The rest keep their title, their
                    ordinal and their "Go" link, so nothing becomes
                    unreachable. */}
                {!step.done && (roomy || isNext) && (
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
                        className="btn-secondary flex w-full text-sm sm:inline-flex sm:w-auto"
                      >
                        <MailWarning size={15} /> Resend confirmation email
                      </button>
                    )}
                  </div>
                )}

                {!step.done && step.href && isNext && (
                  <Link
                    to={step.href}
                    className="btn-primary mt-3 flex w-full text-sm sm:inline-flex sm:w-auto"
                  >
                    {step.title} <ArrowRight size={15} />
                  </Link>
                )}
                {/* A quiet link, not a second button — one obvious next move per
                    screen is the whole point of the list. It still has to be
                    hittable with a thumb, so it claims the 44px floor below
                    `sm` and gives it back where there is a pointer. */}
                {!step.done && step.href && !isNext && (
                  <Link
                    to={step.href}
                    className="link-ink mt-2 inline-flex min-h-[44px] items-center gap-1 text-sm sm:min-h-0"
                  >
                    Go <ArrowRight size={13} aria-hidden />
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* The phone's replacement for the rows hidden above. It carries the count
          that is now missing and the way to reach them, so nothing the collapse
          removed becomes unreachable. */}
      {!roomy && !state.complete && remaining > 0 && (
        <Link
          to="/onboarding"
          className="rule mt-0 flex items-center justify-between gap-3 py-3 text-sm text-slate-600 sm:hidden dark:text-slate-300"
        >
          <span>
            <span className="num font-medium text-slate-900 dark:text-slate-100">
              {remaining}
            </span>{' '}
            more {remaining === 1 ? 'step' : 'steps'}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 font-medium text-brand-600 dark:text-brand-400">
            View all <ArrowRight size={14} aria-hidden />
          </span>
        </Link>
      )}
    </Section>
  );
}
