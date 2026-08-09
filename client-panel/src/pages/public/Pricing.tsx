import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Check, Info } from 'lucide-react';
import { getNetworks, getSignupStatus } from '@/lib/api';
import { useReveal, revealDelay } from '@/lib/useReveal';

/**
 * Public pricing explainer.
 *
 * Deliberately shows the commission MODEL rather than a hard number: rates are
 * per-account, versioned in the `commissions` table and set by the operator, so
 * quoting a fixed figure here would go stale silently. The merchant's own,
 * authoritative rate is always on their Commission page.
 */

const models = [
  {
    name: 'Percentage',
    body: 'A percentage of each settled payment. The most common arrangement — it scales with your volume and there is nothing to reconcile.',
    example: '1% of a 500 USDT payment = 5 USDT',
  },
  {
    name: 'Fixed',
    body: 'A flat fee per settled payment regardless of size. Predictable, and usually better when your average order value is high.',
    example: '0.50 USDT per payment, whatever the amount',
  },
  {
    name: 'Tiered',
    body: 'Slab-based: the payment falls into one band and that band’s rate applies to the whole amount. Suits mixed baskets of small and large orders.',
    example: '<10 → 1 USDT flat · 10–1000 → 1% · >1000 → 0.5%',
  },
];

const included = [
  'Unlimited API keys, scoped and revocable',
  'Unique deposit address per payment',
  'Signed webhooks with automatic retries and delivery logs',
  'Automatic settlement to your own wallet',
  'IP allowlisting and idempotent payment creation',
  'Full payment, payout and commission history',
];

export default function Pricing() {
  const revealRef = useReveal<HTMLDivElement>();
  const { data: networks } = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 5 * 60_000,
  });
  const { data: signupEnabled } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  return (
    <div ref={revealRef}>
      <section className="relative overflow-hidden bg-mesh">
        <div className="absolute inset-0 bg-grid" aria-hidden />
        <div className="section relative text-center">
          <p className="reveal eyebrow">Pricing</p>
          <h1 className="reveal mt-3 h-display" style={revealDelay(1)}>
            You pay a commission.{' '}
            <span className="text-gradient">Nothing else.</span>
          </h1>
          <p className="reveal lede mx-auto mt-5 max-w-2xl" style={revealDelay(2)}>
            No setup fee, no monthly minimum, no charge for API keys or webhooks.
            A commission is deducted when a payment settles, and your exact rate is
            always visible in your dashboard.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="reveal mx-auto max-w-2xl text-center">
          <h2 className="h-section">Three commission models</h2>
          <p className="lede mt-4">
            Your operator sets which one applies to your account. Every change is
            versioned, so you can always see what was in force when a payment settled.
          </p>
        </div>

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {models.map((m, i) => (
            <div key={m.name} className="reveal glass-card flex flex-col p-7" style={revealDelay(i)}>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                {m.name}
              </h3>
              <p className="mt-2.5 flex-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {m.body}
              </p>
              <p className="mt-5 rounded-lg bg-slate-100 px-3 py-2.5 font-mono text-xs text-slate-600 dark:bg-slate-800/70 dark:text-slate-300">
                {m.example}
              </p>
            </div>
          ))}
        </div>

        <div className="reveal mt-8 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
          <Info size={18} className="mt-0.5 shrink-0" />
          <p>
            <strong>Network fees are separate.</strong> Moving USDT on-chain costs
            gas, and your agreement specifies whether that is deducted from your
            settlement or absorbed by the gateway. Your dashboard shows which
            applies, on the Commission page.
          </p>
        </div>
      </section>

      <section className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section grid gap-12 lg:grid-cols-2">
          <div className="reveal">
            <h2 className="h-section">Included on every account</h2>
            <p className="lede mt-4">
              There is no higher tier to buy. Every merchant gets the full API and
              every security control.
            </p>
            <ul className="mt-7 space-y-3">
              {included.map((t) => (
                <li key={t} className="flex gap-2.5 text-sm text-slate-700 dark:text-slate-300">
                  <Check size={17} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="reveal glass-card p-7" style={revealDelay(1)}>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-50">
              Settlement networks
            </h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              What this gateway can settle right now:
            </p>
            <ul className="mt-5 space-y-3">
              {(networks ?? ['BEP20']).map((n) => (
                <li
                  key={n}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 dark:border-slate-700"
                >
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    USDT · {n}
                  </span>
                  <span className="chip">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
                    live
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-xs leading-relaxed text-slate-500">
              Balances are tracked separately per network — funds are not fungible
              across chains, and each has its own settlement wallet.
            </p>
          </div>
        </div>
      </section>

      <section className="section text-center">
        <div className="reveal">
          <h2 className="h-section">Ready when you are</h2>
          <p className="lede mx-auto mt-4 max-w-lg">
            Create an account and see your exact commission before you take a single
            payment.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link to={signupEnabled ? '/signup' : '/login'} className="btn-primary-lg">
              {signupEnabled ? 'Create your account' : 'Sign in'} <ArrowRight size={18} />
            </Link>
            <Link to="/developers" className="btn-secondary-lg">
              Developer guide
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
