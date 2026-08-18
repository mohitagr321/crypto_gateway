import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Check, CheckCircle2, Mail, XCircle } from 'lucide-react';
import AuthShell, { Notice } from '@/components/AuthShell';
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
 *
 * ---------------------------------------------------------------------------
 * DELIBERATELY BARE.
 *
 * Three states, each of which once centred a 44-52px icon inside a tinted
 * rounded panel roughly 200px tall — the standard way a page with almost no
 * content pretends to have some. There is a real surface here now, supplied by
 * the shell, and the correct amount of content to put on it is still exactly
 * what each state has: one sentence of state and at most one action. A page
 * with three sentences on it is allowed to be a page with three sentences on it
 * once the sentences are sitting on something.
 *
 * The colour rule an older version broke twice: success was `brand`, which made
 * the interactive hue mean "good outcome" on this one screen, and failure was
 * `text-red-500` in both themes — the one step that must never carry text,
 * because it fails AA on the paper ground. Success is emerald (verified),
 * failure is red at 600 in light and 400 in dark, and both go through the
 * funnel's shared <Notice> so all six screens state a result the same way.
 *
 * `aside={null}` ON EVERY STATE, and that is load-bearing rather than a
 * judgement about the copy. This page swaps its entire body AFTER mount, but
 * React reconciles the three returns into the same AuthShell instance, so the
 * shell's useReveal() never re-runs — it collected its targets when the shell
 * mounted, during the `working` state. Any `.reveal` reaching the DOM later
 * (the default standing matter carries four) would never be observed and would
 * render permanently INVISIBLE in browsers without scroll-driven animation.
 * No supporting column may appear here.
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
      <AuthShell
        runhead="Confirm your email"
        title="Confirming your email"
        subtitle="One moment."
        aside={null}
      >
        {/* Ranged left with everything else, not centred in a tall empty box.
            The label gives the spinner an accessible name — its role="status"
            announced nothing at all before. */}
        <Spinner size={22} label="Checking your link…" />
      </AuthShell>
    );
  }


  if (state === 'done') {
    return (
      <AuthShell
        runhead="Confirm your email"
        title="You're all set"
        subtitle="Your email is confirmed and your account is active. Taking you to your dashboard…"
        aside={null}
      >
        <div className="space-y-5">
          <Notice tone="ok" icon={CheckCircle2} live="status">
            Account activated
          </Notice>
          {/* The redirect fires in 1.4s; this is the manual path for anyone it
              does not reach, and the only brand-coloured thing on the page. */}
          <Link to="/onboarding" className="btn-primary w-full">
            Continue to setup
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      runhead="Confirm your email"
      title="This link didn't work"
      /* The standfirst is now the EXPLANATION, and the server's message has
         moved down into the alert line where a failure belongs. Both strings
         still appear, and the reason a reader needs — why a link stops working,
         and what to do about it — is the one on the reading measure. */
      subtitle="Confirmation links expire after 24 hours and can only be used once. Enter your email and we'll send a fresh one."
      aside={null}
      footer={
        <>
          Already confirmed?{' '}
          <Link to="/login" className="link-ink">
            Sign in
          </Link>
          .
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <Notice tone="failed" icon={XCircle}>
            {error}
          </Notice>
        )}

        {resent ? (
          <Notice tone="ok" icon={Check} live="status">
            If that address needs confirming, a new link is on its way.
          </Notice>
        ) : (
          <form
            className="space-y-4"
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
              {/* The leading icon every other field in the funnel carries. It
                  was the one bare input across six screens, which is exactly
                  the sort of difference nobody notices and everybody feels. */}
              <div className="relative">
                <Mail
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
                  aria-hidden
                />
                <input
                  id="verify-email"
                  type="email"
                  required
                  className="input pl-9"
                  placeholder="you@yourcompany.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
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
