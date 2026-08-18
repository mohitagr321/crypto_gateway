import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import AuthShell, { Notice } from '@/components/AuthShell';
import { errorMessage, resetPassword } from '@/lib/api';

interface FormValues {
  newPassword: string;
  confirmPassword: string;
}

/**
 * Consumes the emailed reset token and sets a new password.
 *
 * Unlike VerifyEmail this does NOT auto-consume on mount — the token is spent
 * only when the form is submitted, so a link pre-fetched by a mail scanner
 * stays usable for the human who actually clicks it.
 *
 * Resetting also marks the address verified server-side (proving inbox control
 * is at least as strong as clicking the original link), so we send the user to
 * sign in rather than back through confirmation.
 *
 * THREE STATES, ALL PRESERVED: no token in the URL, the form, and done. So is
 * the failure path — an expired or already-used token comes back from the API as
 * one indistinguishable error, and the message still carries the inline "request
 * a new one" escape, because a dead link with no way out is the worst screen in
 * the funnel.
 *
 * ON A SURFACE. The brand-tinted rounded panels that once held the tick and the
 * envelope are still gone: they spent the brand hue on decoration and drew a
 * box round a single glyph. What the form sits on now is the shell's own
 * rim-lit panel, which is a box that means something. Confirmation is emerald —
 * the documented "this succeeded" hue — through the funnel's shared <Notice>,
 * carried by a word and an icon as well as by colour.
 *
 * NO `.reveal` IN THIS FILE, DELIBERATELY, and the shell now enforces it by
 * scoping its observer to the <aside>. It would otherwise be a trap: `done`
 * renders into the SAME AuthShell instance, so a `.reveal` there would never be
 * observed and would stay at opacity 0 forever in a browser without
 * scroll-driven animation.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [show, setShow] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>();

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1800);
    } catch (err) {
      setError(errorMessage(err, 'This reset link is invalid or has expired.'));
    } finally {
      setSubmitting(false);
    }
  });

  if (!token) {
    return (
      <AuthShell
        runhead="Password reset · broken link"
        title="This link is incomplete"
        subtitle="The reset link is missing its token. Request a fresh one and use the newest email."
        aside={<AboutThisLink />}
        footer={
          <>
            Got here by mistake?{' '}
            <Link to="/login" className="link-ink font-medium">
              Back to sign in
            </Link>
          </>
        }
      >
        <Link to="/forgot-password" className="btn-primary w-full">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        runhead="Password reset · done"
        title="Password updated"
        subtitle="You can now sign in with your new password. Taking you there…"
        aside={null}
      >
        {/* Emerald because this is the documented "it worked" hue, and never
            emerald ALONE: the headline, this sentence and the icon all say so
            independently of colour. */}
        <Notice tone="ok" icon={CheckCircle2} live="status">
          New password saved, and your email address is confirmed at the same
          time — there is nothing left to click in your inbox.
        </Notice>

        <Link to="/login" className="btn-primary mt-5 w-full">
          Sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      runhead="Password reset"
      title="Choose a new password"
      subtitle="Pick something you don't use anywhere else — this password guards your settlement settings."
      aside={<AboutThisLink />}
      footer={
        <Link to="/login" className="link-ink font-medium">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error && (
          <Notice tone="failed" icon={AlertCircle}>
            {error}{' '}
            <Link to="/forgot-password" className="font-medium underline underline-offset-2">
              Request a new one
            </Link>
          </Notice>
        )}

        <div>
          <label className="label" htmlFor="newPassword">
            New password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              id="newPassword"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus
              className="input pl-9 pr-12"
              placeholder="At least 10 characters"
              aria-invalid={errors.newPassword ? true : undefined}
              aria-describedby={errors.newPassword ? 'newPassword-error' : undefined}
              {...register('newPassword', {
                required: 'Password is required',
                minLength: { value: 10, message: 'Use at least 10 characters' },
              })}
            />
            {/* A 44px target around a 16px glyph. The box is transparent and
                the icon has not moved; only the hit area grew. This one toggles
                BOTH fields, which is why it lives on the first and why its
                label has to name the action rather than the field. */}
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-0.5 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-slate-400 transition-colors duration-[var(--dur-press)] hover:text-slate-700 sm:h-9 sm:w-9 dark:hover:text-slate-200"
              aria-label={show ? 'Hide password' : 'Show password'}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.newPassword && (
            <p id="newPassword-error" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {errors.newPassword.message}
            </p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="confirmPassword">
            Confirm new password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              id="confirmPassword"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              className="input pl-9"
              placeholder="Repeat it"
              aria-invalid={errors.confirmPassword ? true : undefined}
              aria-describedby={errors.confirmPassword ? 'confirmPassword-error' : undefined}
              {...register('confirmPassword', {
                required: 'Please confirm your password',
                validate: (v) => v === watch('newPassword') || 'Passwords do not match',
              })}
            />
          </div>
          {errors.confirmPassword && (
            <p id="confirmPassword-error" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {errors.confirmPassword.message}
            </p>
          )}
        </div>

        {/* NOT <Spinner/>: its icon is hardcoded `text-brand-600`, which is
            .btn-primary's own background — the button went visually BLANK for
            the whole request. Loader2 direct inherits the button's white, and
            the label says what is happening rather than leaving a bare glyph to
            imply it. `.motion-keep` is required or the reduced-motion catch-all
            freezes it, and a frozen spinner reads as a hung request. */}
        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 size={16} className="motion-keep animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            'Update password'
          )}
        </button>
      </form>
    </AuthShell>
  );
}

/* -------------------------------------------------------------------------- */

/* The local FormError is gone — see the note in ForgotPassword. One <Notice> in
   AuthShell now serves all six funnel screens. */

const linkFacts = [
  {
    term: 'A scanner cannot burn it',
    body: 'The token is spent when you submit this form, not when the page loads, so a link opened by a mail filter is still there for you.',
  },
  {
    term: 'Expired and already used look alike',
    body: 'Both come back as the same refusal, on purpose. Request a fresh link and use the newest email — the older one is retired the moment a new one is issued.',
  },
  {
    term: 'It confirms your email too',
    body: 'Choosing a password here proves you control the inbox, so the address is marked confirmed at the same time and you sign straight in afterwards.',
  },
];

/**
 * Standing matter for the reset step, on the canvas rather than on a surface of
 * its own — the panel beside it is what the reader has to act on. The figure is
 * the fact that governs every question a person has on this screen: the link is
 * worth exactly one submitted password, and loading the page costs nothing.
 */
function AboutThisLink() {
  return (
    <>
      <span className="runhead">About this link</span>

      <div className="mt-6">
        <span className="figure-xl text-gradient">1</span>
        <span className="figure-label measure">
          use per link, spent on submit. It also expires an hour after it was
          sent, whichever comes first.
        </span>
      </div>

      <ul className="mt-10">
        {linkFacts.map(({ term, body }) => (
          <li key={term} className="rule py-5 first:border-t-0 first:pt-0">
            <span className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
              {term}
            </span>
            <p className="measure mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {body}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
