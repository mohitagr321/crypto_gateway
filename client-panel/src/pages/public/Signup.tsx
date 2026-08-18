import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Globe,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Eye,
  EyeOff,
} from 'lucide-react';
import AuthShell, { Notice } from '@/components/AuthShell';
import { LoadingPanel } from '@/components/Spinner';
import { errorMessage, getSignupStatus, register as registerApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { revealDelay } from '@/lib/useReveal';
import type { RegisterInput } from '@/types';

/**
 * Two-step signup.
 *
 * Split because asking for six fields at once measurably costs completions, and
 * because step 1 is the only part we strictly need — the business details in
 * step 2 exist so an operator can recognise the account later.
 *
 * Validation is client-side only for immediacy; the API re-validates everything
 * (same 10-character password floor). The API's response is deliberately
 * identical whether or not the address is already registered, so this page can
 * never say "that email is taken" — it always routes to "check your inbox".
 *
 * SET ON A SURFACE, like the rest of the funnel. AuthShell supplies the depth
 * field, the masthead, the running head, the headline and the panel; this file
 * is the form on it. The fields used to be RULED ROWS in a ledger, which was
 * the broadsheet idiom — six hairlines stacked down a column, each one drawing
 * a line the eye has to cross to reach the next input. Inside a lit panel the
 * panel is the enclosure, so the rules are gone and the fields are simply a
 * stack. That also makes this screen and /login the same object, which they
 * were never quite before.
 *
 * Four things beyond the reskin, each of which was a rule break or a defect:
 *
 *   THE STEP INDEX no longer fills with brand. It used to be two brand-600
 *   discs and a brand-600 progress bar, which is the brand hue indicating
 *   STATE — the one thing it may never do. Progress is carried by stroke
 *   weight (hairline -> ink), by the label going from slate to ink, and by a
 *   tick on the step you have finished. Three carriers, none of them hue. It is
 *   also no longer a hard `grid-cols-2`: below ~19rem the two labels stack
 *   rather than being squeezed into 9rem each.
 *
 *   THE ACKNOWLEDGEMENT MOVED INTO A `.well`. It is the one thing on this page
 *   a merchant can be held to, and an inset group says "read this" on a lit
 *   panel in a way a hairline above a checkbox does not. The checkbox also
 *   takes `accent-*` now: without the forms plugin, `text-brand-600` on a
 *   native checkbox styled nothing at all, so the control rendered in the UA's
 *   own blue in both themes.
 *
 *   THE PASSWORD REVEAL IS A 44px TARGET. It was a bare 16px glyph.
 *
 *   THE STRENGTH READOUT still leads with the WORD, and the word takes the
 *   semantic ink as well, so the meaning survives with the bars unseen.
 *
 *   THE FIELDS ARE DESCRIBED. Hints and errors are wired to their input with
 *   aria-describedby and aria-invalid, which the old markup left unconnected —
 *   a sighted user saw "Enter a valid email address", a screen-reader user
 *   heard only "Work email, invalid entry".
 *
 * NO `.reveal` ANYWHERE IN THE FORM, and that is now enforced by the shell
 * rather than by this comment: AuthShell scopes its reveal observer to the
 * supporting column, so a `.reveal` on a conditionally-rendered field here
 * would simply do nothing rather than pinning the field at opacity 0. The form
 * is the thing the visitor came for and should not be faded in at them; the
 * expressiveness this route earns lives in the column beside it.
 */

interface FormValues extends RegisterInput {
  acceptTerms: boolean;
}

/** Cheap, honest strength signal — length first, then variety. */
function scorePassword(pw: string): {
  score: number;
  label: string;
  /** Fill for the meter segments. A bar is not text, so the 500 step is fine. */
  bar: string;
  /** Ink for the WORD. 700 on paper / 400 on ink, the house pair for semantic text. */
  text: string;
} {
  if (!pw) return { score: 0, label: '', bar: '', text: '' };
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  const red = { bar: 'bg-red-500', text: 'text-red-700 dark:text-red-400' };
  const amber = { text: 'text-amber-700 dark:text-amber-400' };
  // Emerald, not brand. This ramp runs red -> amber -> GOOD, which makes it a
  // state readout, and brand is the colour of things you can click — capping a
  // state ramp with it teaches "brand = good outcome" on this one page and
  // "brand = clickable" on every other. Strong and Very strong share a hue
  // because the segment count already distinguishes them.
  const good = {
    bar: 'bg-emerald-600 dark:bg-emerald-400',
    text: 'text-emerald-700 dark:text-emerald-400',
  };

  if (pw.length < 10) return { score: 1, label: 'Too short', ...red };
  if (score <= 2) return { score: 2, label: 'Weak', bar: 'bg-amber-500', ...amber };
  if (score === 3) return { score: 3, label: 'Fair', bar: 'bg-amber-400', ...amber };
  if (score === 4) return { score: 4, label: 'Strong', ...good };
  return { score: 5, label: 'Very strong', ...good };
}

/** The two steps, named. This array IS the step index. */
const STEPS = ['Sign-in details', 'Your business'] as const;

/** Two-digit index for the ruled lists. Tabular, so the rules line up. */
const ord = (i: number) => String(i + 1).padStart(2, '0');

export default function Signup() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const { data: enabled, isLoading: statusLoading } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  const {
    register,
    handleSubmit,
    trigger,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ mode: 'onBlur' });

  const password = watch('password') ?? '';
  const strength = scorePassword(password);

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  if (statusLoading) return <LoadingPanel />;
  if (enabled === false) {
    return (
      <AuthShell
        runhead="Registration closed"
        title="Registration is closed"
        subtitle="This gateway is not currently accepting new merchant accounts. If you were expecting an account, contact your operator — they can provision one for you directly."
        // No standing matter on a dead end: a column arguing for the product is
        // noise when the reader cannot act on it. The form column deliberately
        // does not re-centre.
        aside={null}
      >
        <Link to="/login" className="btn-primary w-full">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const goToStep2 = async () => {
    setError(null);
    const ok = await trigger(['email', 'password']);
    if (ok) setStep(2);
  };

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    try {
      await registerApi({
        email: values.email.trim(),
        password: values.password,
        businessName: values.businessName.trim(),
        websiteUrl: values.websiteUrl?.trim() || undefined,
        country: values.country?.trim() || undefined,
      });
      // The response says nothing about whether the address was new. Always
      // route to "check your inbox" — that is the only honest next step.
      navigate('/check-email', {
        replace: true,
        state: { email: values.email.trim() },
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <AuthShell
      runhead={`New account · step ${step} of 2`}
      title="Create your merchant account"
      subtitle="Confirm your email and you're active — no approval queue, no sales call."
      aside={<WhatHappensNext />}
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="link-ink font-medium">
            Sign in
          </Link>
        </>
      }
    >
      {/* ========================= THE STEP INDEX =========================
          A contents line, not a widget. The rule over a step you have reached
          is INK; the one ahead of you stays a hairline. A finished step also
          carries a tick, so progress reads without any reliance on hue — which
          is what let the brand-filled discs go.

          `auto-fit` rather than `grid-cols-2`. At 360px, inside the panel's own
          padding, a hard two-column split gives each label about 9rem, and
          "Sign-in details" then sets on two cramped lines beside a heading that
          has room to spare. `minmax(min(100%,9rem),1fr)` keeps the index
          horizontal wherever two columns genuinely fit and stacks it where they
          do not, with no breakpoint to keep in step with the copy. */}
      <ol className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-4 gap-y-3">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const reached = step >= n;
          const done = step > n;
          return (
            <li
              key={label}
              aria-current={step === n ? 'step' : undefined}
              className={`min-w-0 pt-2.5 ${
                reached
                  ? 'border-t border-slate-900 dark:border-slate-100'
                  : 'rule'
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="runhead num">{ord(i)}</span>
                {done && (
                  <>
                    <Check size={12} className="shrink-0 text-slate-400" aria-hidden />
                    <span className="sr-only">completed</span>
                  </>
                )}
              </span>
              <span
                className={`mt-1 block text-sm font-medium tracking-tight ${
                  reached
                    ? 'text-slate-900 dark:text-slate-100'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" aria-live="polite">
        Step {step} of 2
      </p>

      <form onSubmit={onSubmit} className="mt-6" noValidate>
        {/* The funnel's shared notice. Red is the state; the icon and the
            sentence are what actually carry it. */}
        {error && (
          <div className="mb-5">
            <Notice tone="failed" icon={AlertCircle}>
              {error}
            </Notice>
          </div>
        )}

        {/* key={step} forces React to unmount step 1's inputs rather than
            reconcile them into step 2's. Without it the two steps' <input>
            elements occupy the same position in the tree, React reuses the DOM
            node, and the value typed into "email" reappears in
            "businessName" — the field arrives pre-filled with the address. */}
        {step === 1 ? (
          <div key="step-1" className="space-y-5">
            <Field
              id="email"
              label="Work email"
              hint="Your confirmation link and any account notices go here."
              icon={Mail}
              error={errors.email?.message}
            >
              <input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                className="input pl-9"
                placeholder="you@yourcompany.com"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={
                  errors.email ? 'email-error email-hint' : 'email-hint'
                }
                {...register('email', {
                  required: 'Email is required',
                  pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
                })}
              />
            </Field>

            <Field
              id="password"
              label="Password"
              hint="Ten characters minimum. A short passphrase beats one mangled word."
              icon={Lock}
              error={errors.password?.message}
              after={
                password ? (
                  <div className="mt-3">
                    {/* Square segments, not pills: the meter is a ruled gauge,
                        and nothing here animates — a colour transition is not
                        a compositor property. */}
                    <div className="flex gap-1" aria-hidden>
                      {[1, 2, 3, 4, 5].map((i) => (
                        <span
                          key={i}
                          className={`h-[3px] flex-1 ${
                            i <= strength.score
                              ? strength.bar
                              : 'bg-slate-200 dark:bg-slate-800'
                          }`}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-xs leading-relaxed" aria-live="polite">
                      <span className={`font-medium ${strength.text}`}>
                        {strength.label}
                      </span>
                      {strength.score < 4 && (
                        <span className="text-slate-500 dark:text-slate-400">
                          {' '}
                          — mix upper and lower case, digits and a symbol
                        </span>
                      )}
                    </p>
                  </div>
                ) : null
              }
            >
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                className="input pl-9 pr-12"
                placeholder="At least 10 characters"
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={
                  errors.password ? 'password-error password-hint' : 'password-hint'
                }
                {...register('password', {
                  required: 'Password is required',
                  minLength: { value: 10, message: 'Use at least 10 characters' },
                })}
              />
              {/* A 44px target around a 16px glyph — the box is transparent
                  and the icon has not moved. The hand-rolled focus ring is
                  gone with it: `:focus-visible` is defined once in the base
                  layer, and a second spelling of it is how one control ends up
                  with a different ring from the other eight. */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0.5 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-slate-400 transition-colors duration-[var(--dur-press)] hover:text-slate-700 sm:h-9 sm:w-9 dark:hover:text-slate-200"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </Field>

            {/* The commit row, divided from the fields by the one kind of rule
                this system still keeps: a hairline dividing WITHIN a surface. */}
            <div className="rule pt-5">
              <button type="button" onClick={goToStep2} className="btn-primary w-full">
                Continue <ArrowRight size={16} />
              </button>
              <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Next: your business details — the part that lets an operator
                recognise your account later.
              </p>
            </div>
          </div>
        ) : (
          <div key="step-2" className="space-y-5">
            <Field
              id="businessName"
              label="Business name"
              hint="The name an operator will recognise this account by."
              icon={Building2}
              error={errors.businessName?.message}
            >
              <input
                id="businessName"
                autoFocus
                className="input pl-9"
                placeholder="Acme Commerce Ltd"
                aria-invalid={errors.businessName ? true : undefined}
                aria-describedby={
                  errors.businessName
                    ? 'businessName-error businessName-hint'
                    : 'businessName-hint'
                }
                {...register('businessName', {
                  required: 'Business name is required',
                  minLength: { value: 2, message: 'Enter your business name' },
                })}
              />
            </Field>

            <Field
              id="websiteUrl"
              label={<>Website <Optional /></>}
              icon={Globe}
              error={errors.websiteUrl?.message}
            >
              <input
                id="websiteUrl"
                type="url"
                className="input pl-9"
                placeholder="https://acme.com"
                aria-invalid={errors.websiteUrl ? true : undefined}
                aria-describedby={errors.websiteUrl ? 'websiteUrl-error' : undefined}
                {...register('websiteUrl', {
                  pattern: {
                    value: /^https?:\/\/.+\..+/,
                    message: 'Include http:// or https://',
                  },
                })}
              />
            </Field>

            <Field
              id="country"
              label={<>Country <Optional /></>}
              icon={MapPin}
            >
              <input
                id="country"
                className="input pl-9"
                placeholder="India"
                {...register('country')}
              />
            </Field>

            {/* THE ACKNOWLEDGEMENT, IN A WELL. It is the one thing on this page
                a merchant may be held to, and burying it as a trailing checkbox
                reads as a trick. An inset group is the system's way of saying
                "this is set into the panel, read it" — a raised surface inside
                a raised surface would just be two cards.

                The whole label is the target, which is what keeps this over the
                44px floor: an 18px box with a two-line sentence beside it is a
                ~48px row, all of it clickable. */}
            <div className="well p-4">
              <span className="runhead">Before you start</span>
              <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {/* `accent-*`, not `text-*`. There is no forms plugin in this
                    build, so the control is a NATIVE checkbox and `text-brand-600`
                    styled precisely nothing — it rendered in the UA's own blue,
                    in both themes, on the one control this page requires. */}
                <input
                  type="checkbox"
                  className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-brand-600"
                  aria-invalid={errors.acceptTerms ? true : undefined}
                  aria-describedby={errors.acceptTerms ? 'acceptTerms-error' : undefined}
                  {...register('acceptTerms', { required: true })}
                />
                <span>
                  I understand that crypto transactions are irreversible and that
                  settlement depends on network confirmations.
                </span>
              </label>
              {errors.acceptTerms && (
                <p
                  id="acceptTerms-error"
                  className="mt-2 text-xs text-red-600 dark:text-red-400"
                >
                  Please confirm to continue
                </p>
              )}
            </div>

            <div className="rule pt-5">
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="btn-secondary"
                  disabled={submitting}
                >
                  <ArrowLeft size={16} /> Back
                </button>
                {/* NOT <Spinner/>: its icon is hardcoded `text-brand-600`,
                    which is .btn-primary's own background — the button went
                    visually BLANK for the whole request. Loader2 direct
                    inherits the button's white, and the label says what is
                    happening rather than leaving a bare glyph to imply it.
                    `.motion-keep` is required or the reduced-motion catch-all
                    freezes it, and a frozen spinner reads as a hung request. */}
                <button type="submit" className="btn-primary flex-1" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="motion-keep animate-spin" aria-hidden />
                      Creating…
                    </>
                  ) : (
                    <>Create account <ArrowRight size={16} /></>
                  )}
                </button>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                No card and no setup fee — a commission is deducted only when a
                payment settles.
              </p>
            </div>
          </div>
        )}
      </form>
    </AuthShell>
  );
}

/** "(optional)" after a label. slate-500 rather than 400: it is still text. */
function Optional() {
  return (
    <span className="font-normal text-slate-500 dark:text-slate-400">(optional)</span>
  );
}

/**
 * One field: label, hint, leading icon, control, inline error — the same parts
 * in the same order as Login's local Field, so the two screens are one design.
 *
 * IT USED TO BE A RULED ROW and is now just a stack. The hairline was doing the
 * enclosing on a page printed straight onto paper; the panel does it now, and
 * six stacked rules inside a lit surface read as a table someone forgot to fill
 * in. Kept local to each page rather than lifted into components/: the two
 * funnel screens are the only callers, and a shared "form field" abstraction is
 * the thing that quietly grows six props.
 *
 * `hint` and `error` both get a stable id so the caller can point
 * aria-describedby at them; the caller owns that wiring because the <input> is
 * passed in as children and cannot be reached from here.
 *
 * `after` is the slot under the input, still inside the field — the password
 * strength meter belongs to its field, not to the gap beneath it.
 */
function Field({
  id,
  label,
  hint,
  icon: Icon,
  error,
  after,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: string;
  icon: typeof Mail;
  error?: string;
  after?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label mb-0" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p
          id={`${id}-hint`}
          className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        >
          {hint}
        </p>
      )}
      <div className="relative mt-2">
        <Icon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
        />
        {children}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {after}
    </div>
  );
}

const afterSignup = [
  {
    title: 'Confirm your email',
    body: 'One link, sent the moment you submit. It works once, expires in 24 hours, and clicking it signs you in.',
  },
  {
    title: 'Set your payout wallet',
    body: 'The address every settled payment is swept to. Changing it always requires a signed-in session, never an API key.',
  },
  {
    title: 'Take your first payment',
    body: 'Create an API key, POST an amount, show the address. A signed webhook tells you the moment it confirms.',
  },
];

/**
 * The supporting column for this step. It replaces the shell's default standing
 * matter because a registration form has one question the reader actually
 * wants answered — what happens after I press the button — and answering it is
 * worth more here than a second recital of the product's virtues.
 *
 * IT STAYS ON THE CANVAS. This is the most expressive route in the funnel and
 * it still does not get a surface of its own: two lit panels would be two
 * offers, and the reader is here to take one. The `.rule-strong` that opened it
 * is gone with the rest of the broadsheet furniture — a running head above a
 * 7.5rem figure does not need a stroke to announce it.
 *
 * The figure is `0`, and it is the one this page is arguing: there is no review
 * queue between submitting and being live. It carries the brand -> accent
 * gradient because signup is a marketing-frequency route and this is the single
 * figure the column is built around, which is the whole brief for
 * `.text-gradient`.
 *
 * REVEALS HERE ARE SAFE because this markup mounts with the shell and never
 * changes with `step`. Nothing conditional in this component, ever — AuthShell's
 * useReveal() collects targets once on mount, and an element that appears later
 * would stay at opacity 0 in a browser without scroll-driven animation.
 */
function WhatHappensNext() {
  return (
    <>
      <span className="runhead">What happens next</span>

      <div className="reveal mt-6">
        <span className="figure-xl text-gradient">0</span>
        <span className="figure-label measure">
          approvals to wait for. No review queue and no sales call — confirm your
          email and the account is live.
        </span>
      </div>

      <ol className="mt-10">
        {afterSignup.map((s, i) => (
          <li
            key={s.title}
            className="reveal rule py-5 first:border-t-0 first:pt-0"
            style={revealDelay(i + 1)}
          >
            <div className="flex items-baseline gap-2.5">
              <span className="runhead num shrink-0">{ord(i)}</span>
              <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                {s.title}
              </span>
            </div>
            <p className="measure mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {s.body}
            </p>
          </li>
        ))}
      </ol>

      <p
        className="reveal rule measure pt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        style={revealDelay(4)}
      >
        Every payment settles to a wallet you control — this account never takes
        custody of your funds.{' '}
        <Link to="/developers" className="link-ink">
          Read the developer guide
        </Link>
        .
      </p>
    </>
  );
}
