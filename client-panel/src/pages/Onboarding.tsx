import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import OnboardingChecklist from '@/components/OnboardingChecklist';
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
 * SET AS A SPREAD, NOT A STACK OF CARDS. The checklist runs down the wide
 * column and the margin column carries the two things a merchant reads while
 * they wait on themselves: where to go next, and the one security fact that
 * decides how they hand out keys. Both used to be cards, which made three
 * boxes of equal weight out of one task and two footnotes.
 *
 * The masthead, the loading state and the error state all keep the same
 * running head, so a slow request changes what is on the page rather than what
 * page you appear to be on.
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
  // placeholder is `.ghost` — static by design, because `.skeleton` shimmers
  // on a loop and loops are banned on a dashboard route.
  if (query.isLoading) {
    return (
      <>
        <Masthead />
        <div className="grid gap-x-10 gap-y-10 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <div className="ghost h-5 w-44" />
            <div className="ghost mt-4 h-2 w-full" />
            <div className="mt-8 space-y-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="rule pt-5">
                  <div className="ghost h-4 w-1/3" />
                  <div className="ghost mt-2.5 h-3 w-3/4" />
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

      <div className="grid gap-x-10 gap-y-10 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <OnboardingChecklist
            state={state}
            variant="page"
            onResendVerification={() => resend.mutate()}
            resendPending={resend.isPending}
            resendSent={resendSent}
          />

          {/* The close. A ruled band under a heavy stroke, not a brand-tinted
              panel with a party glyph in it: brand means "something you can
              click", and spending it as a celebratory fill is exactly the
              decoration this idiom exists to remove. The two things you can
              click are still brand, because they are buttons. */}
          {state.complete && (
            <div className="rule-strong mt-10 pt-6">
              <span className="runhead">Ready</span>
              <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
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
            </div>
          )}
        </div>

        <aside className="min-w-0 lg:col-span-4">
          <span className="runhead">While you're here</span>
          {/* A ruled list, not a card of links: the hairline does the
              separating, and the row is the target. The 2px nudge on the arrow
              is hover-driven, so it costs a visit nothing. */}
          <ul className="mt-3 border-b border-slate-200 dark:border-slate-800">
            {ASIDE_LINKS.map((l) => (
              <li key={l.to}>
                <Link
                  to={l.to}
                  className="rule group flex items-baseline justify-between gap-4 py-3 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900 underline decoration-transparent underline-offset-[3px] group-hover:decoration-brand-600 dark:text-slate-100 dark:group-hover:decoration-brand-400">
                      {l.label}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                      {l.hint}
                    </span>
                  </span>
                  <ArrowRight
                    size={14}
                    aria-hidden
                    className="shrink-0 translate-y-0.5 text-slate-400 transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] group-hover:translate-x-0.5"
                  />
                </Link>
              </li>
            ))}
          </ul>

          <div className="rule mt-8 pt-5">
            <span className="runhead">A note on security</span>
            <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              Your settlement wallet, password and API keys can only be changed from
              a signed-in session here — never with an API key. Keep your account
              password strong, and give each integration its own key so you can
              revoke one without breaking the others.
            </p>
          </div>
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
