import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import OnboardingChecklist from '@/components/OnboardingChecklist';
import Section from '@/components/Section';
import ErrorState from '@/components/ErrorState';
import { errorMessage, getOnboarding, resendVerification } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

/**
 * The "get started" page a merchant lands on right after verifying their email.
 *
 * It re-polls while incomplete because the steps are completed on OTHER pages
 * (Settings, API Keys) — coming back here should show fresh state without a
 * manual refresh.
 *
 * SET AS A SPREAD OF SURFACES. The checklist runs down the wide column and the
 * narrow one carries the two things a merchant reads while they wait on
 * themselves: where to go next, and the one security fact that decides how they
 * hand out keys. Each is its own titled surface, so the page has three things
 * on it rather than one long ruled column in which every heading has the same
 * standing as every other.
 *
 * THE CHECKLIST IS RENDERED BARE, deliberately — exactly as Dashboard renders
 * it. It is a shared component with its own internal structure and its own
 * conversion; wrapping it here would either double its head or nest a surface
 * inside a surface. It presents itself.
 *
 * The masthead, the loading state and the error state all keep the same running
 * head, so a slow request changes what is on the page rather than what page you
 * appear to be on.
 */

/** Where a merchant usefully goes while the checklist is still open. */
const ASIDE_LINKS = [
  { to: '/docs', label: 'API reference', hint: 'Endpoints, signing, examples' },
  { to: '/commission', label: 'Your commission', hint: 'What is deducted per payment' },
  { to: '/webhook-logs', label: 'Webhook deliveries', hint: 'Every attempt, with responses' },
];

export default function Onboarding() {
  const { user } = useAuth();
  const [resendSent, setResendSent] = useState(false);

  const query = useQuery({
    queryKey: ['onboarding'],
    queryFn: getOnboarding,
    // Cheap query; keeping it live avoids a stale checklist after a detour.
    refetchInterval: (q) => (q.state.data?.complete ? false : 20_000),
    refetchOnWindowFocus: true,
  });

  const resend = useMutation({
    mutationFn: () => resendVerification(String(user?.email ?? '')),
    onSuccess: () => setResendSent(true),
    // The endpoint is intentionally uninformative, so a failure here says
    // nothing useful — show the same acknowledgement either way.
    onError: () => setResendSent(true),
  });

  // Loading and error keep the masthead rather than replacing the page with a
  // centred glyph: the header is already correct before the request answers,
  // and holding it still means nothing jumps when the data lands. The
  // placeholder is `.ghost` — static by design, because a shimmer loops and
  // loops are banned on a dashboard route.
  if (query.isLoading) {
    return (
      <>
        <Masthead />
        <div className="grid gap-3 lg:grid-cols-12">
          <div className="surface min-w-0 p-4 sm:p-5 lg:col-span-8" aria-busy="true">
            <span className="sr-only" role="status">
              Loading…
            </span>
            <div className="ghost h-5 w-44" aria-hidden />
            <div className="ghost mt-4 h-2 w-full" aria-hidden />
            <div className="mt-8 space-y-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="border-t border-[var(--line-soft)] pt-5">
                  <div
                    className="ghost h-4 w-1/3"
                    aria-hidden
                    style={{ opacity: Math.max(0.3, 1 - i * 0.15) }}
                  />
                  <div className="ghost mt-2.5 h-3 w-3/4" aria-hidden />
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  if (query.isError || !query.data) {
    return (
      <>
        <Masthead />
        <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} />
      </>
    );
  }

  const state = query.data;

  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title={state.complete ? 'Setup complete' : 'Get started'}
        description={
          state.complete
            ? 'Everything is configured. Here are the useful next steps.'
            : 'A few steps and your account can take live payments.'
        }
        meta={
          <>
            {state.completedRequired} of {state.totalRequired} required steps done
          </>
        }
      />

      <div className="grid gap-3 lg:grid-cols-12">
        <div className="min-w-0 space-y-3 lg:col-span-8">
          <OnboardingChecklist
            state={state}
            variant="page"
            onResendVerification={() => resend.mutate()}
            resendPending={resend.isPending}
            resendSent={resendSent}
          />

          {/* The close. A titled surface, not a brand-tinted panel with a party
              glyph in it: brand means "something you can click", and spending it
              as a celebratory fill is exactly the decoration this design exists
              to remove. The two things you can click are still brand, because
              they are buttons. */}
          {state.complete && (
            <Section title="Ready">
              <h2 className="text-xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
                You're ready to take live payments
              </h2>
              <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Create one from the dashboard to watch the full lifecycle, or point
                your integration at the API and let it run.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <Link to="/payments/new" className="btn-primary text-sm">
                  Create a payment <ArrowRight size={15} />
                </Link>
                <Link to="/dashboard" className="btn-secondary text-sm">
                  Go to dashboard
                </Link>
              </div>
            </Section>
          )}
        </div>

        <aside className="min-w-0 space-y-3 lg:col-span-4">
          {/* `flush`: the rows draw their own hairlines and are the targets, so
              they range to the edges of the surface rather than being inset
              from the rules that divide them. Each row is two lines at `py-3`,
              which clears the 44px touch floor without being told to. */}
          <Section flush title="While you're here">
            <ul>
              {ASIDE_LINKS.map((l) => (
                <li key={l.to} className="border-t border-[var(--line-soft)] first:border-t-0">
                  <Link
                    to={l.to}
                    className="group flex items-baseline justify-between gap-4 rounded-lg py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900 underline decoration-transparent underline-offset-[3px] group-hover:decoration-brand-600 dark:text-slate-100 dark:group-hover:decoration-brand-400">
                        {l.label}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                        {l.hint}
                      </span>
                    </span>
                    {/* The 2px nudge is hover-driven, so it costs a visit
                        nothing, travels well under the 8px budget, and animates
                        transform only. */}
                    <ArrowRight
                      size={14}
                      aria-hidden
                      className="shrink-0 translate-y-0.5 text-slate-500 transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] group-hover:translate-x-0.5 dark:text-slate-400"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="A note on security">
            <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              Your settlement wallet, password and API keys can only be changed from
              a signed-in session here — never with an API key. Keep your account
              password strong, and give each integration its own key so you can
              revoke one without breaking the others.
            </p>
          </Section>
        </aside>
      </div>
    </>
  );
}

/**
 * The masthead the loading and error states borrow. Deliberately the neutral
 * copy: before the request answers we do not know whether setup is complete,
 * and guessing would flip the title out from under the reader a second later.
 */
function Masthead() {
  return (
    <PageHeader
      eyebrow="Setup"
      title="Get started"
      description="A few steps and your account can take live payments."
    />
  );
}
