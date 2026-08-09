import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { MailCheck, RefreshCw, Check } from 'lucide-react';
import AuthShell from '@/components/AuthShell';
import Spinner from '@/components/Spinner';
import { errorMessage, resendVerification } from '@/lib/api';

/**
 * Post-signup dead-end screen. Its only jobs are to say "go look in your inbox"
 * and to offer a resend, because a missing verification email is the single most
 * common place a self-serve funnel stalls.
 *
 * The email is passed via router state rather than a query string — it is
 * personal data and does not belong in a URL that lands in browser history and
 * referrer headers.
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
      setError(errorMessage(err, 'Could not resend right now. Try again shortly.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthShell
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
      footer={
        <>
          Wrong address?{' '}
          <Link to="/signup" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Start over
          </Link>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center justify-center rounded-2xl border border-brand-200 bg-brand-50/60 py-10 dark:border-brand-900/60 dark:bg-brand-900/15">
          <MailCheck className="text-brand-600 animate-float dark:text-brand-400" size={44} />
        </div>

        <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
          <li>· The link expires in 24 hours and works once.</li>
          <li>· Check your spam folder — confirmation mail often lands there.</li>
        </ul>

        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </p>
        )}

        {email &&
          (sent ? (
            <p className="flex items-center justify-center gap-2 rounded-lg bg-brand-50 px-3 py-2.5 text-sm font-medium text-brand-700 dark:bg-brand-900/25 dark:text-brand-300">
              <Check size={16} /> Sent again — give it a minute to arrive.
            </p>
          ) : (
            <button
              type="button"
              onClick={resend}
              className="btn-secondary w-full"
              disabled={sending}
            >
              {sending ? <Spinner size={16} /> : <><RefreshCw size={16} /> Resend the link</>}
            </button>
          ))}

        <Link to="/login" className="btn-ghost w-full">
          Back to sign in
        </Link>
      </div>
    </AuthShell>
  );
}
