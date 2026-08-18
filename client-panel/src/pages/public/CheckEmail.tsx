import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertCircle, Check, Loader2, RefreshCw } from 'lucide-react';
import AuthShell, { Notice } from '@/components/AuthShell';
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
 * A LOW-CONTENT PAGE, which is exactly where a template starts padding: an
 * older version filled the column with a 44px mail icon floating inside a
 * brand-tinted rounded panel and stacked two full-width buttons under it. The
 * tinted panel spent the brand hue on decoration; the "sent again" confirmation
 * used brand as a STATE; and the second button ("Back to sign in") was
 * navigation dressed as an action. None of that came back.
 *
 * What the panel holds now is one action and the two things worth knowing while
 * you wait, set into a `.well` — an inset group is how this system marks
 * "supporting detail inside the thing you are doing", and it keeps a page with
 * three sentences on it from looking like a page with three sentences on it.
 * Navigation stays demoted to text links under the panel. The one number worth
 * stating — 24 — is set enormous in the supporting column rather than buried in
 * a bullet.
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
            {/* `break-words` on the address, and it is not defensive coding for
                its own sake: an email is a single unbreakable token, the lede
                is set at 18px, and a 45-character address is wider than the
                panel on a 360px phone — which drags the entire page sideways
                rather than merely looking untidy. */}
            If{' '}
            <strong className="break-words text-slate-900 dark:text-slate-100">
              {email}
            </strong>{' '}
            can be registered, we've sent it a confirmation link. Click it to
            activate your account — you'll be signed in automatically.
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
      <div className="space-y-5">
        {/* STATE, WITH A SHAPE. On a lit panel a bare coloured sentence reads as
            a label rather than as a state, so both of these take the funnel's
            <Notice>: a tint, an inset ring, an icon and the sentence. Red is a
            failure, emerald is "this worked" — and each ships three carriers, so
            neither depends on hue. */}
        {error && (
          <Notice tone="failed" icon={AlertCircle}>
            {error}
          </Notice>
        )}

        {/* THE SINGLE ACTION. Secondary rather than primary on purpose: the real
            next step is in the reader's mail client, not on this page, and a
            big brand button here invites a resend before the first mail has
            even landed. */}
        {email &&
          (sent ? (
            <Notice tone="ok" icon={Check} live="status">
              Sent again — give it a minute to arrive.
            </Notice>
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

        {/* Two notes, set into the panel. These stay in the MAIN column — the
            supporting column is dropped below `lg`, and "check your spam
            folder" is the one piece of advice a phone most needs. The rule
            falls BETWEEN them only; a stroke under the last note would leave a
            line hanging inside the well. */}
        <ul className="well px-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          {notes.map((note) => (
            <li key={note} className="rule py-3.5 first:border-t-0">
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
 * The supporting column. One running head, one enormous figure, one footnote —
 * the expiry rule is the only fact worth stating here, and it is a number, so
 * it is set as one instead of being filed away as a third bullet. The figure
 * takes the brand -> accent gradient: the signup funnel is marketing-frequency
 * and this is the one figure the column exists to state.
 *
 * Dropped below `lg` by the shell, so nothing here competes with the action on
 * a phone. Anything a reader must have on a small screen belongs in the main
 * column, not in this one.
 */
function WhileYouWait() {
  return (
    <>
      <span className="runhead">If it does not arrive</span>

      <div className="reveal mt-6">
        <span className="figure-xl text-gradient">24</span>
        <span className="figure-label measure">
          hours before the link expires, and each one works exactly once. If you
          resend, open the newest mail — the earlier link stops working.
        </span>
      </div>

      <p
        className="reveal rule measure mt-10 pt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        style={revealDelay(1)}
      >
        Confirming is how we know the address is really yours. It is the one
        thing that stops an account being opened in your name with a mailbox you
        do not control.
      </p>
    </>
  );
}
