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
import AuthShell from '@/components/AuthShell';
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
 * SET AS A BROADSHEET, like the rest of the public funnel. The form is not a
 * card: AuthShell supplies the masthead, the running head and the reading
 * measure, and every field here is a RULED ROW in a ledger rather than a boxed
 * group. Three things changed beyond the styling, and each was a rule break:
 *
 *   THE STEP INDEX no longer fills with brand. It used to be two brand-600
 *   discs and a brand-600 progress bar, which is the brand hue indicating
 *   STATE — the one thing it may never do. Progress is now carried by stroke
 *   weight (hairline -> ink), by the label going from slate to ink, and by a
 *   tick on the step you have finished. Three carriers, none of them hue.
 *
 *   THE STRENGTH READOUT still leads with the WORD, and the word now takes the
 *   semantic ink as well, so the meaning survives with the bars unseen.
 *
 *   THE FIELDS ARE DESCRIBED. Hints and errors are wired to their input with
 *   aria-describedby and aria-invalid, which the old markup left unconnected —
 *   a sighted user saw "Enter a valid email address", a screen-reader user
 *   heard only "Work email, invalid entry".
 *
 * NO `.reveal` ANYWHERE IN THE FORM, on purpose and by rule. AuthShell's
 * useReveal() collects its targets once on mount, so anything rendered
 * conditionally — every field on step 2, the strength meter, the error alert —
 * would never be observed and would sit at opacity 0 in a browser without
 * scroll-driven animation. The form is also the thing the visitor came for and
 * should not be faded in at them. Reveals live only in the margin column.
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
          A newspaper contents line, not a widget. The rule over a step you
          have reached is INK; the one ahead of you stays a hairline. A
          finished step also carries a tick, so progress reads without any
          reliance on hue — which is what let the brand-filled discs go. */}
      <ol className="grid grid-cols-2 gap-x-4">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const reached = step >= n;
          const done = step > n;
          return (
            <li
              key={label}
              aria-current={step === n ? 'step' : undefined}
              className={`pt-2.5 ${
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

      <form onSubmit={onSubmit} className="mt-7" noValidate>
        {/* A stroke and a word, not a tinted box. Red is the state; the icon
            and the sentence are what actually carry it. */}
        {error && (
          <div
            role="alert"
            className="flex gap-2.5 border-t-2 border-red-600 pt-3 dark:border-red-400"
          >
            <AlertCircle
              size={16}
              className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"
              aria-hidden
            />
            <p className="text-sm leading-relaxed text-red-700 dark:text-red-400">
              {error}
            </p>
          </div>
        )}

        {/* key={step} forces React to unmount step 1's inputs rather than
            reconcile them into step 2's. Without it the two steps' <input>
            elements occupy the same position in the tree, React reuses the DOM
            node, and the value typed into "email" reappears in
            "businessName" — the field arrives pre-filled with the address. */}
        {step === 1 ? (
          <div key="step-1">
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
                className="input pl-9 pr-10"
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
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-slate-400 outline-none hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:text-slate-300"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </Field>

            <div className="rule pt-6">
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
          <div key="step-2">
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

            {/* The acknowledgement gets its own ruled group and its own running
                head. It is the one thing on this page a merchant may be held
                to, and burying it as a trailing checkbox reads as a trick. */}
            <div className="rule py-5">
              <span className="runhead">Before you start</span>
              <label className="mt-3 flex items-start gap-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
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

            <div className="rule pt-6">
              <div className="flex gap-3">
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
 * One field, set as a RULED ROW rather than a boxed group — the hairline does
 * the separating a border-and-padding card was doing, for a pixel.
 *
 * `hint` and `error` both get a stable id so the caller can point
 * aria-describedby at them; the caller owns that wiring because the <input> is
 * passed in as children and cannot be reached from here.
 *
 * `after` is the slot under the input, inside the same ruled row — the password
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
    <div className="rule py-5">
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
 * The margin column for this step. It replaces the shell's default standing
 * matter because a registration form has one question the reader actually
 * wants answered — what happens after I press the button — and answering it is
 * worth more here than a second recital of the product's virtues.
 *
 * The figure is `0`, and it is the one this page is arguing: there is no review
 * queue between submitting and being live.
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
      <div className="rule-strong mt-3" aria-hidden />

      <div className="reveal mt-8">
        <span className="figure-xl">0</span>
        <span className="figure-label">
          approvals to wait for. No review queue and no sales call — confirm your
          email and the account is live.
        </span>
      </div>

      <ol className="mt-10">
        {afterSignup.map((s, i) => (
          <li key={s.title} className="reveal rule py-5" style={revealDelay(i + 1)}>
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
