import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, BookOpen, PartyPopper } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import OnboardingChecklist from '@/components/OnboardingChecklist';
import ErrorState from '@/components/ErrorState';
import { LoadingPanel } from '@/components/Spinner';
import { errorMessage, getOnboarding, resendVerification } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';

/**
 * The "get started" page a merchant lands on right after verifying their email.
 *
 * It re-polls while incomplete because the steps are completed on OTHER pages
 * (Settings, API Keys) — coming back here should show fresh state without a
 * manual refresh.
 */
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

  if (query.isLoading) return <LoadingPanel />;
  if (query.isError || !query.data) {
    return (
      <ErrorState message={errorMessage(query.error)} onRetry={() => query.refetch()} />
    );
  }

  const state = query.data;

  return (
    <>
      <PageHeader
        title={state.complete ? 'Setup complete' : 'Get started'}
        description={
          state.complete
            ? 'Everything is configured. Here are the useful next steps.'
            : 'A few steps and your account can take live payments.'
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="card p-6 sm:p-8">
            <OnboardingChecklist
              state={state}
              variant="page"
              onResendVerification={() => resend.mutate()}
              resendPending={resend.isPending}
              resendSent={resendSent}
            />
          </div>

          {state.complete && (
            <div className="card mt-6 flex items-start gap-4 border-brand-200 bg-brand-50/60 p-6 dark:border-brand-900/60 dark:bg-brand-900/15">
              <PartyPopper className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" size={22} />
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  You're ready to take live payments
                </h3>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                  Create one from the dashboard to watch the full lifecycle, or point
                  your integration at the API and let it run.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Link to="/payments/new" className="btn-primary text-sm">
                    Create a payment <ArrowRight size={15} />
                  </Link>
                  <Link to="/dashboard" className="btn-secondary text-sm">
                    Go to dashboard
                  </Link>
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="space-y-6">
          <div className="card p-6">
            <div className="flex items-center gap-2">
              <BookOpen size={17} className="text-brand-600 dark:text-brand-400" />
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                While you're here
              </h3>
            </div>
            <ul className="mt-4 space-y-3 text-sm">
              {[
                { to: '/docs', label: 'API reference', hint: 'Endpoints, signing, examples' },
                { to: '/commission', label: 'Your commission', hint: 'What is deducted per payment' },
                { to: '/webhook-logs', label: 'Webhook deliveries', hint: 'Every attempt, with responses' },
              ].map((l) => (
                <li key={l.to}>
                  <Link
                    to={l.to}
                    className="group flex items-start justify-between gap-3 rounded-lg p-2.5 transition hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span>
                      <span className="block font-medium text-slate-800 dark:text-slate-200">
                        {l.label}
                      </span>
                      <span className="block text-xs text-slate-500">{l.hint}</span>
                    </span>
                    <ArrowRight
                      size={15}
                      className="mt-1 shrink-0 text-slate-400 transition group-hover:translate-x-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="card p-6">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              A note on security
            </h3>
            <p className="mt-2.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
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
