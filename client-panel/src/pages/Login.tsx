import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import AuthShell from '@/components/AuthShell';
import { getSignupStatus } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import type { LoginInput } from '@/types';

/**
 * Merchant sign-in.
 *
 * SET IN TYPE, like the rest of the funnel. AuthShell owns the frame — the
 * masthead, the running head, the .rule-strong, the <h1>, the standfirst, the
 * hairline footer and the margin column — so this file is only the form, and
 * it deliberately renders the SAME primitives Signup does (.label, .input with
 * a slate-400 leading icon, .btn-primary) so the two screens read as one
 * product rather than as two designs that happen to share a header.
 *
 * What changed here is enclosure and hue, not behaviour:
 *
 *   - The error banner was a rounded red-tinted box. It is now a NOTICE ON A
 *     RULE — one 2px stroke in the margin, no fill, no radius. Rules, not
 *     boxes, and a hairline says "this belongs to the field below it" as
 *     clearly as a filled card did.
 *   - That notice is now TONED BY MEANING. `error` carries two different
 *     things: a genuine failure, and the "we need your second factor" step,
 *     which is not a failure at all — it is the flow waiting on the user.
 *     Failure is red, waiting is amber, and each ships an ICON and the
 *     sentence itself so the hue is never the only thing carrying it.
 *   - The second factor is separated from the credentials by a hairline
 *     instead of just stacking, so it reads as a second act.
 *   - Brand hue is now only the submit button, the link underlines and the
 *     focus ring. The two inline links moved to .link-ink (ink text, 1px
 *     brand underline) — coloured link text next to a coloured button was two
 *     things competing to be the thing you click.
 *
 * MOTION: none, on purpose. AuthShell's useReveal() observes this subtree, but
 * nothing here carries .reveal — /login is opened daily by merchants already
 * reaching for the password field, and fading it in taxes them for arriving.
 * It would also be unsafe: the notice and the 2FA field mount CONDITIONALLY,
 * and useReveal collects its targets once, on mount.
 *
 * BEHAVIOUR IS UNTOUCHED: the redirect-to-intended-route logic (both the
 * already-authenticated short circuit and the post-login navigate), the
 * unverified-email detour to /onboarding, the MFA round trip, the API error
 * message fallback, and the live signup-status read that decides whether a
 * "create one" link is offered at all.
 */

/**
 * Hoisted so the render can recognise it. `login()` reports "we need your
 * second factor" through the same `error` slot a real failure uses, and the
 * only honest way to tone it differently is to compare against the exact
 * string we ourselves put there. Nothing about the flow changes — this is a
 * presentation test on a literal this file owns both ends of.
 */
const MFA_PROMPT = 'Enter the 6-digit code from your authenticator app.';

interface LocationState {
  from?: { pathname?: string };
}

export default function Login() {
  const { isAuthenticated, login, mfaRequired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const { data: signupEnabled } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>();

  if (isAuthenticated) {
    const to = (location.state as LocationState)?.from?.pathname ?? '/dashboard';
    return <Navigate to={to} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await login(values);
      if (res.mfaRequired) {
        setError(MFA_PROMPT);
        return;
      }
      // A merchant who signed up but never clicked their confirmation link goes
      // to the onboarding checklist, whose first step is exactly that. Sending
      // them to a dashboard they cannot transact from would just confuse.
      if (!res.emailVerified) {
        navigate('/onboarding', { replace: true });
        return;
      }
      const to = (location.state as LocationState)?.from?.pathname ?? '/dashboard';
      navigate(to, { replace: true });
    } catch (err) {
      setError((err as ApiError).message || 'Invalid credentials.');
    } finally {
      setSubmitting(false);
    }
  });

  // Waiting on the user, not a failure — see MFA_PROMPT above.
  const awaitingCode = error === MFA_PROMPT;

  return (
    <AuthShell
      runhead="Sign in"
      title="Welcome back"
      subtitle="Sign in to your merchant dashboard — payments, payouts, webhook deliveries and API keys."
      footer={
        signupEnabled ? (
          <>
            Don't have an account?{' '}
            <Link to="/signup" className="link-ink font-medium">
              Create one
            </Link>
          </>
        ) : (
          // No wrapper styling: the shell's footer already sets the size and
          // the ink, and a second copy here only fights it.
          <>Accounts on this gateway are provisioned by your operator.</>
        )
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {/* A notice on a rule, not a tinted box. Amber for "waiting on you",
            red for "that did not work" — each with its own icon and its own
            sentence, so the hue is reinforcement rather than the message.
            Amber sets at the 700 step on paper because amber-600 does not
            clear AA on this ground; ink keeps the documented 400. */}
        {error && (
          <div
            role="alert"
            className={`flex items-start gap-2.5 border-l-2 py-1 pl-3 text-sm leading-relaxed ${
              awaitingCode
                ? 'border-amber-600 text-amber-700 dark:border-amber-400 dark:text-amber-400'
                : 'border-red-600 text-red-700 dark:border-red-400 dark:text-red-400'
            }`}
          >
            {awaitingCode ? (
              <ShieldCheck size={15} className="mt-0.5 shrink-0" aria-hidden />
            ) : (
              <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
            )}
            <span>{error}</span>
          </div>
        )}

        <Field id="email" label="Email" icon={Mail} error={errors.email?.message}>
          <input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            className="input pl-9"
            placeholder="merchant@example.com"
            {...register('email', { required: 'Email is required' })}
          />
        </Field>

        <Field
          id="password"
          label="Password"
          icon={Lock}
          error={errors.password?.message}
          action={
            <Link to="/forgot-password" className="link-ink mb-1.5 text-xs font-medium">
              Forgot?
            </Link>
          }
        >
          <input
            id="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            className="input pl-9 pr-10"
            placeholder="••••••••"
            {...register('password', { required: 'Password is required' })}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </Field>

        {/* The second factor is a second act, so it gets a hairline rather
            than another 16px of the same gap. No .reveal: this mounts after
            the shell's observer has already collected its targets. */}
        {mfaRequired && (
          <div className="rule pt-4">
            <Field id="mfaToken" label="Two-factor code" icon={ShieldCheck}>
              <input
                id="mfaToken"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="input pl-9 tracking-widest"
                placeholder="123456"
                {...register('mfaToken')}
              />
            </Field>
          </div>
        )}

        {/* The busy state used <Spinner/>, whose icon is hardcoded
            `text-brand-600` — the exact colour of .btn-primary's own
            background (#4f46e5), so the button went BLANK while the request
            was in flight. Loader2 direct inherits the button's white instead,
            and the label now says what is happening rather than leaving a
            bare glyph to imply it. `.motion-keep` is required: the
            reduced-motion catch-all in index.css would otherwise freeze it,
            and a frozen spinner reads as a hung request. */}
        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 size={16} className="motion-keep animate-spin" aria-hidden />
              Signing in…
            </>
          ) : (
            <>
              <KeyRound size={16} aria-hidden /> Sign in
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}

/**
 * Label, leading icon, control, inline error — the same four parts, in the
 * same order, as Signup's local Field. Kept local to each page rather than
 * lifted into components/: the two funnel screens are the only callers, and a
 * shared "form field" abstraction is the thing that quietly grows six props.
 *
 * `action` is the one addition this screen needs: the "Forgot?" link sits on
 * the label's baseline, which is where a reader looks when the password they
 * were about to type has just failed them.
 */
function Field({
  id,
  label,
  icon: Icon,
  error,
  action,
  children,
}: {
  id: string;
  label: React.ReactNode;
  icon: typeof Mail;
  error?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        {action}
      </div>
      <div className="relative">
        <Icon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
        />
        {children}
      </div>
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
