import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertCircle, Check, Loader2, RefreshCw } from 'lucide-react';
import AuthShell from '@/components/AuthShell';
import { errorMessage, resendVerification } from '@/lib/api';
import { revealDelay } from '@/lib/useReveal';

/**
 * Post-signup dead-end screen. Its only jobs are to say "go look in your inbox"
 * and to offer a resend, because a missing verification email is the single most
 * common place a self-serve funnel stalls.
 *
 * The email is passed via router state rather than a query string — it is
 * personal data and does not belong in a URL that lands in browser history and
 * referrer headers.
 *
 * SET IN TYPE. This is a low-content page, which is exactly where a template
 * starts padding: the old version filled the column with a 44px mail icon
 * floating inside a brand-tinted rounded panel, then stacked two full-width
 * buttons under it. All three were wrong. The tinted panel spent the brand hue
 * on decoration; the "sent again" confirmation used brand as a STATE; and the
 * second button ("Back to sign in") was navigation dressed as an action.
 *
 * What is left is the shape the direction asks for: a running head, one
 * statement on the reading measure (the shell's standfirst), ONE action, two
 * ruled notes, and the navigation demoted to text links in the footer. The one
 * number worth stating — 24 — is set enormous in the margin column instead of
 * being buried in a bullet.
 */
export default function CheckEmail() {
  const location = useLocation();
  const email = (location.state as { email?: string } | null)?.email ?? '';

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resend = async () => {
    if (!email) return;
    setError(null);
    setSending(true);
    try {
      await resendVerification(email);
      setSent(true);
    } catch (err) {
      // The endpoint is rate limited; its message is the useful one, so it is
      // shown verbatim rather than replaced with a generic failure.
      setError(errorMessage(err, 'Could not resend right now. Try again shortly.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthShell
      runhead="Confirm your email"
      title="Check your inbox"
      subtitle={
        email ? (
          <>
            If <strong className="text-slate-900 dark:text-slate-100">{email}</strong> can be
            registered, we've sent it a confirmation link. Click it to activate your
            account — you'll be signed in automatically.
          </>
        ) : (
          <>
            We've sent a confirmation link to the address you entered. Click it to
            activate your account.
          </>
        )
      }
      /* Better margin copy than the default standing matter: on this screen the
         reader is waiting, so the column answers the one question they have.
         Safe to carry .reveal — this markup mounts WITH the page (the page never
         swaps its shell), which is the condition useReveal requires. */
      aside={<WhileYouWait />}
      footer={
        <>
          Wrong address?{' '}
          <Link to="/signup" className="link-ink">
            Start over
          </Link>
          . Already confirmed?{' '}
          <Link to="/login" className="link-ink">
            Sign in
          </Link>
          .
        </>
      }
    >
      <div className="space-y-6">
        {/* STATE, NOT DECORATION. No tinted panel behind either of these: a
            hairline-free line of coloured type with an icon beside it carries
            the meaning, and the icon is what keeps the hue from being the only
            thing saying it. Red at the 600/400 steps, emerald at 700/400 —
            never the 500 step, which fails AA on paper. */}
        {error && (
          <p
            role="alert"
            className="flex items-start gap-2 text-sm font-medium text-red-600 dark:text-red-400"
          >
            <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        )}

        {/* THE SINGLE ACTION. Secondary rather than primary on purpose: the real
            next step is in the reader's mail client, not on this page, and a
            big brand button here invites a resend before the first mail has
            even landed. */}
        {email &&
          (sent ? (
            <p
              role="status"
              className="flex items-start gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
            >
              <Check size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>Sent again — give it a minute to arrive.</span>
            </p>
          ) : (
            <button
              type="button"
              onClick={resend}
              className="btn-secondary w-full"
              disabled={sending}
            >
              {/* NOT <Spinner/>: its icon is hardcoded `text-brand-600`, which
                  sits at brand on a slate button in light and barely separates
                  from slate-800 in dark. Loader2 direct inherits the button's
                  own ink in BOTH themes, and the label says what is happening
                  instead of leaving a bare glyph to imply it. `.motion-keep` is
                  required or the reduced-motion catch-all freezes it, and a
                  frozen spinner reads as a hung request. */}
              {sending ? (
                <>
                  <Loader2 size={16} className="motion-keep animate-spin" aria-hidden />
                  Sending…
                </>
              ) : (
                <>
                  <RefreshCw size={16} aria-hidden /> Resend the link
                </>
              )}
            </button>
          ))}

        {/* Two notes, divided by rules rather than bulleted inside a grey box.
            These stay in the MAIN column — the margin column is hidden below
            lg, and "check your spam folder" is the advice a phone most needs. */}
        <ul className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          {notes.map((note) => (
            <li key={note} className="rule py-3.5">
              {note}
            </li>
          ))}
        </ul>
      </div>
    </AuthShell>
  );
}

const notes = [
  'Give it a minute. Mail can sit in a queue before it lands.',
  'Look in spam or promotions — confirmation mail often ends up there.',
];

/**
 * The margin column. One running head, one enormous figure, one footnote — the
 * expiry rule is the only fact worth stating here, and it is a number, so it is
 * set as one instead of being filed away as a third bullet.
 *
 * Hidden below lg by the shell, so nothing here competes with the action on a
 * phone. Anything a reader must have on a small screen belongs in the main
 * column, not in this one.
 */
function WhileYouWait() {
  return (
    <>
      <span className="runhead">If it does not arrive</span>
      <div className="rule-strong mt-3" aria-hidden />

      <div className="reveal mt-8">
        <span className="figure-xl">24</span>
        <span className="figure-label">
          hours before the link expires, and each one works exactly once. If you
          resend, open the newest mail — the earlier link stops working.
        </span>
      </div>

      <p
        className="reveal rule mt-10 pt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        style={revealDelay(1)}
      >
        Confirming is how we know the address is really yours. It is the one
        thing that stops an account being opened in your name with a mailbox you
        do not control.
      </p>
    </>
  );
}
