import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { AlertCircle, Loader2, Mail } from 'lucide-react';
import AuthShell, { Notice } from '@/components/AuthShell';
import { errorMessage, forgotPassword } from '@/lib/api';

/**
 * Password reset request.
 *
 * ENUMERATION SAFETY IS THE WHOLE POINT OF THIS SCREEN and none of the editorial
 * work below touches it: the API answers `202 Accepted` whether or not the
 * address has an account, this page always shows the same success state, and the
 * only failure it can surface is a transport/rate-limit error — which says
 * nothing about the address either. The restructure actually STATES that rule to
 * the reader instead of hiding it, because a merchant who mistypes their address
 * and gets a cheerful "check your inbox" deserves to know why no mail arrives.
 *
 * ON A SURFACE, like the rest of the funnel. An older success state was a 12rem
 * brand-tinted rounded panel with a floating envelope in it — brand hue spent
 * on decoration, and a box drawn around nothing. What replaced it was two facts
 * separated by hairlines on bare paper; what it is now is those same two facts
 * in a `.well`, set into the shell's panel. The distinction matters: a hairline
 * enclosure has to be inferred, an inset one is seen. The supporting column
 * carries the standing matter for each step.
 *
 * NO `.reveal` IN THIS FILE, DELIBERATELY, and the shell now enforces it — its
 * reveal observer is scoped to the <aside>, and both of this page's asides are
 * static. It would otherwise be a trap: the `sent` branch renders into the SAME
 * AuthShell instance (React reconciles it rather than remounting), so anything
 * appearing with `sent` would never be observed. Half a funnel that animates
 * and half that does not is worse than a funnel that simply arrives.
 */
export default function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ email: string }>();

  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    setSubmitting(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, 'Could not send the reset email. Try again shortly.'));
    } finally {
      setSubmitting(false);
    }
  });

  if (sent) {
    return (
      <AuthShell
        runhead="Password reset · link sent"
        title="Check your inbox"
        subtitle="If that address has an account, we've sent it a link to choose a new password. It expires in an hour."
        aside={<NotArriving />}
        footer={
          <>
            This page replies the same way whether or not that address has an
            account. That is deliberate — it means nobody can use this form to
            find out who banks here.
          </>
        }
      >
        {/* Two facts, set into the panel. The rule falls BETWEEN them only —
            a stroke under the last one would hang inside the well, and the
            well's own edge is already the bottom of the group. */}
        <ul className="well px-4">
          {sentNotes.map(({ term, body }) => (
            <li key={term} className="rule py-4 first:border-t-0">
              <span className="block text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                {term}
              </span>
              <p className="measure mt-1.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {body}
              </p>
            </li>
          ))}
        </ul>

        <Link to="/login" className="btn-primary mt-5 w-full">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      runhead="Password reset"
      title="Reset your password"
      subtitle="Enter the email on your account and we'll send you a link to set a new password."
      aside={<LinkRules />}
      footer={
        <>
          Remembered it?{' '}
          <Link to="/login" className="link-ink font-medium">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error && (
          <Notice tone="failed" icon={AlertCircle}>
            {error}
          </Notice>
        )}

        <div>
          <label className="label" htmlFor="email">
            Email address
          </label>
          <div className="relative">
            <Mail
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              className="input pl-9"
              placeholder="you@yourcompany.com"
              aria-invalid={errors.email ? true : undefined}
              aria-describedby={errors.email ? 'email-error' : undefined}
              {...register('email', {
                required: 'Email is required',
                pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
              })}
            />
          </div>
          {errors.email && (
            <p id="email-error" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
              {errors.email.message}
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
              Sending…
            </>
          ) : (
            'Send reset link'
          )}
        </button>
      </form>
    </AuthShell>
  );
}

/* -------------------------------------------------------------------------- */

/* The local FormError is gone: it was one of four hand-rolled treatments of the
   same idea across six funnel screens, and it now lives once, in AuthShell, as
   <Notice>. */

const sentNotes = [
  {
    term: 'Open the newest message',
    body: 'Requesting another link immediately retires the one before it, so an older email in the thread will not work.',
  },
  {
    term: 'The link sets a password, not a session',
    body: 'Following it lets you choose a new one. You sign in with it afterwards, here.',
  },
];

const linkFacts = [
  {
    term: 'The same reply, every time',
    body: 'This form answers identically whether or not the address has an account, so it can never be used to discover who has one.',
  },
  {
    term: 'One hour to use it',
    body: 'The link expires an hour after it is sent. After that, ask for another — there is no limit on how often.',
  },
  {
    term: 'Nothing changes until you submit',
    body: 'The token is spent when the new password is submitted, not when the page loads, so a mail scanner that pre-fetches the link leaves it usable.',
  },
];

/**
 * Standing matter for the request step, on the canvas rather than on a second
 * surface — the panel beside it is the thing to act on and nothing here should
 * compete with it for that. The figure is the one number that actually changes
 * what a person does next: it explains why the second email is the only one
 * that works, and it is true on every deployment because the server retires
 * outstanding tokens whenever it issues a new one.
 */
function LinkRules() {
  return (
    <>
      <span className="runhead">How the link works</span>

      <div className="mt-6">
        <span className="figure-xl text-gradient">1</span>
        <span className="figure-label measure">
          live reset link per account. Ask for another and the one before it stops
          working — always open the newest email.
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

const troubleshooting = [
  {
    term: 'Check spam and promotions',
    body: 'A first message from a sender you have never had mail from often lands there.',
  },
  {
    term: 'Check the address you typed',
    body: 'It has to be the exact one on the account. A typo gets no mail and no error — that is the same-reply rule doing its job, not a fault.',
  },
  {
    term: 'Give it a minute, then ask again',
    body: 'Delivery is usually seconds. If nothing has landed after a few minutes, request the link again and use the newer email.',
  },
];

/** Standing matter for the sent step: the only question this state produces. */
function NotArriving() {
  return (
    <>
      <span className="runhead">If it does not arrive</span>

      <ul className="mt-6">
        {troubleshooting.map(({ term, body }) => (
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
