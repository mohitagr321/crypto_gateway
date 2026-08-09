import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, XCircle } from 'lucide-react';
import AuthShell from '@/components/AuthShell';
import Spinner from '@/components/Spinner';
import { errorMessage, resendVerification, verifyEmail } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

type State = 'working' | 'done' | 'failed';

/**
 * Landing page for the emailed confirmation link.
 *
 * On success the API returns a token pair, so we adopt the session and drop the
 * merchant straight into onboarding — asking someone to log in immediately after
 * proving they own the address is a pointless extra step and a common place to
 * lose people.
 *
 * The token is consumed exactly once server-side, so the request must fire
 * exactly once. React 18 StrictMode double-invokes effects in development, which
 * would spend the token on the first pass and show the real user a failure — the
 * `attempted` ref is what prevents that.
 *
 * Note there is deliberately NO `cancelled` cleanup flag alongside that ref.
 * Pairing the two is subtly broken: StrictMode's cleanup sets cancelled = true,
 * the second invocation returns early at the ref without clearing it, and the
 * in-flight response is then thrown away — leaving the page spinning forever on
 * a request that actually succeeded. Setting state after unmount is a harmless
 * no-op in React 18, so the ref alone is both necessary and sufficient.
 */
export default function VerifyEmail() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { adoptSession } = useAuth();
  const token = params.get('token') ?? '';

  const [state, setState] = useState<State>(token ? 'working' : 'failed');
  const [error, setError] = useState<string | null>(
    token ? null : 'This link is missing its confirmation token.',
  );
  const [resent, setResent] = useState(false);
  const [email, setEmail] = useState('');
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    (async () => {
      try {
        const res = await verifyEmail(token);
        adoptSession(res.accessToken, res.refreshToken);
        setState('done');
        // Brief pause so the confirmation is actually seen rather than flashing.
        setTimeout(() => navigate('/onboarding', { replace: true }), 1400);
      } catch (err) {
        setError(errorMessage(err, 'We could not confirm this link.'));
        setState('failed');
      }
    })();
  }, [token, adoptSession, navigate]);

  if (state === 'working') {
    return (
      <AuthShell title="Confirming your email" subtitle="One moment.">
        <div className="flex justify-center py-10">
          <Spinner size={30} />
        </div>
      </AuthShell>
    );
  }

  if (state === 'done') {
    return (
      <AuthShell
        title="You're all set"
        subtitle="Your email is confirmed and your account is active. Taking you to your dashboard…"
      >
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-brand-200 bg-brand-50/60 py-12 dark:border-brand-900/60 dark:bg-brand-900/15">
          <CheckCircle2 className="text-brand-600 dark:text-brand-400" size={52} />
          <p className="text-sm font-medium text-brand-700 dark:text-brand-300">
            Account activated
          </p>
        </div>
        <Link to="/onboarding" className="btn-primary mt-5 w-full">
          Continue to setup
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="This link didn't work"
      subtitle={error ?? undefined}
      footer={
        <>
          Already confirmed?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Sign in
          </Link>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center justify-center rounded-2xl border border-red-200 bg-red-50/60 py-10 dark:border-red-900/50 dark:bg-red-900/15">
          <XCircle className="text-red-500" size={44} />
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-400">
          Confirmation links expire after 24 hours and can only be used once.
          Enter your email and we'll send a fresh one.
        </p>

        {resent ? (
          <p className="rounded-lg bg-brand-50 px-3 py-2.5 text-center text-sm font-medium text-brand-700 dark:bg-brand-900/25 dark:text-brand-300">
            If that address needs confirming, a new link is on its way.
          </p>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await resendVerification(email.trim());
              } catch {
                // The endpoint is intentionally uninformative; showing a failure
                // here would leak whether the address exists.
              }
              setResent(true);
            }}
          >
            <div>
              <label className="label" htmlFor="verify-email">
                Email address
              </label>
              <input
                id="verify-email"
                type="email"
                required
                className="input"
                placeholder="you@yourcompany.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <button type="submit" className="btn-primary w-full">
              Send a new link
            </button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
