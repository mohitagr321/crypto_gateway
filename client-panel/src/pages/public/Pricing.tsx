import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Info } from 'lucide-react';
import { getNetworks, getSignupStatus } from '@/lib/api';
import { useReveal, revealDelay } from '@/lib/useReveal';

/**
 * Public pricing explainer.
 *
 * Deliberately shows the commission MODEL rather than a hard number: rates are
 * per-account, versioned in the `commissions` table and set by the operator, so
 * quoting a fixed figure here would go stale silently. The merchant's own,
 * authoritative rate is always on their Commission page.
 *
 * Set as a broadsheet: the models are a RULED COMPARISON rather than three
 * cards, every band carries a running head in the margin column, and each band
 * is anchored by one enormous figure. The hero's figure is a worked example —
 * it is what fills the right half of the opening spread, which used to be empty
 * and left ~190px of dead space above the first heading.
 *
 * The worked example is LABELLED AS ILLUSTRATIVE everywhere it appears. A big
 * number on a pricing page reads as a quote, and this one is not one.
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

/** Two-digit index for the ruled lists. Tabular, so the rules line up. */
const ord = (i: number) => String(i + 1).padStart(2, '0');

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

  // Every capability claim below is read from the gateway, never written into
  // the page — the site cannot advertise a network this deployment can't settle.
  const networkList = networks ?? ['BEP20'];

  return (
    <div ref={revealRef}>
      {/* ============================================================
          OPENING SPREAD. Asymmetric: the statement on the left measure,
          the worked example carrying the figure on the right.
          ============================================================ */}
      <section className="relative overflow-hidden bg-mesh">
        <div className="absolute inset-0 bg-grid" aria-hidden />
        <div className="section relative grid gap-x-10 gap-y-12 lg:grid-cols-12 lg:items-end">
          <div className="lg:col-span-7">
            <p className="reveal runhead">Pricing</p>
            <h1 className="reveal mt-4 h-display" style={revealDelay(1)}>
              You pay a commission. Nothing else.
            </h1>
            <p className="reveal lede measure mt-6" style={revealDelay(2)}>
              No setup fee, no monthly minimum, no charge for API keys or webhooks.
              A commission is deducted when a payment settles, and your exact rate is
              always visible in your dashboard.
            </p>
          </div>

          <div className="reveal lg:col-span-5" style={revealDelay(3)}>
            <p className="runhead">Worked example</p>
            <dl className="mt-4">
              <div className="rule flex items-baseline justify-between gap-4 py-3">
                <dt className="text-sm text-slate-600 dark:text-slate-400">Payment</dt>
                <dd className="num text-sm font-medium text-slate-900 dark:text-slate-100">
                  500.00 USDT
                </dd>
              </div>
              <div className="rule flex items-baseline justify-between gap-4 py-3">
                <dt className="text-sm text-slate-600 dark:text-slate-400">
                  Commission at 1%
                </dt>
                <dd className="num text-sm font-medium text-slate-900 dark:text-slate-100">
                  − 5.00 USDT
                </dd>
              </div>
            </dl>
            {/* The total rule of a ledger: heavier than the rows above it. */}
            <div className="rule-strong pt-5">
              <span className="figure-xl">495.00</span>
              <span className="figure-label">
                USDT settled to your own wallet. Illustrative only — rates are set
                per account and versioned, and your own is on your Commission page.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
          THE MODELS. A ruled comparison, not three cards: name in the
          margin column, the argument on a measure, the worked figure last.
          `pt-0` because the hero's own bottom padding is the gap — two
          stacked py-24 sections were what created the dead band here.
          ============================================================ */}
      <section className="section pt-0">
        <div className="reveal rule-strong grid gap-x-10 gap-y-4 pt-8 lg:grid-cols-12">
          <p className="runhead lg:col-span-3 lg:pt-3">Commission</p>
          <div className="lg:col-span-9">
            <h2 className="h-section">Three commission models</h2>
            <p className="lede measure mt-4">
              Your operator sets which one applies to your account. Every change is
              versioned, so you can always see what was in force when a payment settled.
            </p>
          </div>
        </div>

        <div className="mt-12">
          {models.map((m, i) => (
            <div
              key={m.name}
              className="reveal rule grid gap-x-10 gap-y-4 py-8 lg:grid-cols-12"
              style={revealDelay(i)}
            >
              <div className="lg:col-span-3">
                <span className="runhead num">{ord(i)}</span>
                <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                  {m.name}
                </h3>
              </div>
              <p className="measure text-base leading-relaxed text-slate-600 lg:col-span-5 dark:text-slate-400">
                {m.body}
              </p>
              <div className="lg:col-span-4">
                <span className="runhead">Example</span>
                <p className="num mt-2 font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                  {m.example}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Small print, set as small print. It was an amber box, but amber means
            "waiting" in this palette — this is a footnote, not a state. */}
        <div className="reveal rule flex gap-3 pt-6">
          <Info size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <p className="measure-wide text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            <strong className="font-semibold text-slate-700 dark:text-slate-300">
              Network fees are separate.
            </strong>{' '}
            Moving USDT on-chain costs gas, and your agreement specifies whether that
            is deducted from your settlement or absorbed by the gateway. Your dashboard
            shows which applies, on the Commission page.
          </p>
        </div>
      </section>

      {/* ============================================================
          WHAT YOU GET. Two bands on the tinted stock, each with its
          running head and figure in the margin column.
          ============================================================ */}
      <section className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section">
          <div className="grid gap-x-10 gap-y-10 lg:grid-cols-12">
            <div className="reveal lg:col-span-4">
              <span className="runhead">Included</span>
              <span className="figure-xl mt-6">0</span>
              <span className="figure-label">
                higher tiers to buy. There is nothing above this plan, because there
                is no plan.
              </span>
            </div>

            <div className="lg:col-span-8">
              <h2 className="reveal h-section">Included on every account</h2>
              <p className="reveal lede measure mt-4" style={revealDelay(1)}>
                Every merchant gets the full API and every security control from the
                first payment onwards.
              </p>
              <ul className="mt-8">
                {included.map((t, i) => (
                  <li
                    key={t}
                    className="reveal rule flex gap-5 py-4"
                    style={revealDelay(i)}
                  >
                    <span className="runhead num w-6 shrink-0 pt-1">{ord(i)}</span>
                    <span className="measure text-base leading-relaxed text-slate-700 dark:text-slate-300">
                      {t}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="band mt-8 grid gap-x-10 gap-y-10 pb-0 lg:grid-cols-12">
            <div className="reveal lg:col-span-4">
              <span className="runhead">Networks</span>
              <span className="figure-xl mt-6">{networkList.length}</span>
              <span className="figure-label">
                settlement {networkList.length === 1 ? 'network' : 'networks'} live on
                this gateway, read from the API rather than written into this page.
              </span>
            </div>

            <div className="lg:col-span-8">
              <h2 className="reveal text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                Settlement networks
              </h2>
              <p className="reveal lede measure mt-4" style={revealDelay(1)}>
                What this gateway can settle right now:
              </p>
              <ul className="mt-8">
                {networkList.map((n, i) => (
                  <li
                    key={n}
                    className="reveal rule flex items-center justify-between gap-4 py-4"
                    style={revealDelay(i)}
                  >
                    <span className="text-base font-medium text-slate-900 dark:text-slate-100">
                      USDT · {n}
                    </span>
                    {/* emerald, not brand: this is health, and brand only ever
                        means "something you can click". */}
                    <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
                      live
                    </span>
                  </li>
                ))}
              </ul>
              <p className="rule measure-wide pt-4 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                Balances are tracked separately per network — funds are not fungible
                across chains, and each has its own settlement wallet.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
          CLOSE. Ranged left under a masthead rule, not centred.
          ============================================================ */}
      <section className="section">
        <div className="reveal rule-strong grid gap-x-10 gap-y-4 pt-10 lg:grid-cols-12">
          <p className="runhead lg:col-span-3 lg:pt-3">Get started</p>
          <div className="lg:col-span-9">
            <h2 className="h-section">Ready when you are</h2>
            <p className="lede measure mt-4">
              Create an account and see your exact commission before you take a single
              payment.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to={signupEnabled ? '/signup' : '/login'} className="btn-primary-lg">
                {signupEnabled ? 'Create your account' : 'Sign in'} <ArrowRight size={18} />
              </Link>
              <Link to="/developers" className="btn-secondary-lg">
                Developer guide
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
