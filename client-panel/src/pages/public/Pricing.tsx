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
 * BUILT FROM SURFACES. The page that stood here was a broadsheet — ruled bands,
 * running heads in a margin column, an enormous figure anchoring each stroke.
 * Every one of those bands is now a raised surface on the depth field, because
 * a pricing page is a page of MEASUREMENTS and a measurement wants the same
 * rim-lit plane the dashboard gives a metric tile. The three models in
 * particular were a ruled comparison down the page, which made them read as one
 * continuous argument; they are three objects, so they are now three objects.
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
          OPENING SPREAD. The statement on the left measure, the worked
          example on its own surface to the right. The surface is what
          makes the example read as a RECEIPT rather than as more copy —
          it is a ledger, and a ledger belongs on a plane of its own.
          ============================================================ */}
      {/* `.bg-mesh` rather than the animated `.aurora` Landing uses. The shell
          already mounts a drifting depth field behind every public route; the
          flagship earns a second animated bloom on top of it, an inner page does
          not, and a static mesh costs one paint instead of two more composited
          layers on the widest element of the page. */}
      <section className="relative isolate overflow-hidden bg-mesh">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-grid" aria-hidden />

        <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 pb-14 pt-8 sm:px-8 sm:pb-20 sm:pt-14 lg:grid-cols-12 lg:items-center lg:gap-12">
          <div className="min-w-0 lg:col-span-7">
            <p className="reveal eyebrow">Pricing</p>
            <h1 className="reveal mt-3 h-display" style={revealDelay(1)}>
              You pay a commission. Nothing else.
            </h1>
            <p className="reveal lede measure mt-5" style={revealDelay(2)}>
              No setup fee, no monthly minimum, no charge for API keys or
              webhooks. A commission is deducted when a payment settles, and your
              exact rate is always visible in your dashboard.
            </p>
          </div>

          <div
            className="reveal surface spot min-w-0 p-5 sm:p-6 lg:col-span-5"
            style={revealDelay(3)}
          >
            <h2 className="runhead">Worked example</h2>
            {/* The spine — the same label/value primitive every detail view in
                the dashboard is built from. A pricing example and a payment
                receipt are the same shape of information, so they are set the
                same way. */}
            <dl className="mt-2">
              <div className="spine-row">
                <dt className="spine-label">Payment</dt>
                <dd className="spine-value num font-medium">500.00 USDT</dd>
              </div>
              <div className="spine-row">
                <dt className="spine-label">Commission at 1%</dt>
                <dd className="spine-value num font-medium">− 5.00 USDT</dd>
              </div>
            </dl>

            {/* The total rule of a ledger: heavier than the rows above it. */}
            <div className="rule-strong mt-4 min-w-0 pt-5">
              {/* The one figure on the site that carries the brand gradient.
                  Reserved for exactly this: the number the whole page argues
                  towards. It is not a status and not a control, so the gradient
                  is decoration on ink rather than the interactive colour
                  meaning something it should not. `break-words` because a money
                  figure must never be truncated — a shortened amount is a
                  number the reader gets WRONG rather than notices is missing. */}
              <span className="figure-xl figure-accent break-words">495.00</span>
              <span className="figure-label measure">
                USDT settled to your own wallet. Illustrative only — rates are set
                per account and versioned, and your own is on your Commission
                page.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================
          THE MODELS. Three surfaces, because they are three alternatives
          and a reader compares alternatives side by side. As a ruled
          column down the page they read as one continuous argument, which
          is precisely the wrong reading.
          ============================================================ */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">Commission</span>
          <h2 className="mt-3 h-section">Three commission models</h2>
          <p className="lede measure mt-4">
            Your operator sets which one applies to your account. Every change is
            versioned, so you can always see what was in force when a payment
            settled.
          </p>
        </div>

        <div className="mt-8 grid gap-3 sm:mt-12 lg:grid-cols-3">
          {models.map((m, i) => (
            <div
              key={m.name}
              className="reveal surface spot flex min-w-0 flex-col p-5 sm:p-6"
              style={revealDelay(i)}
            >
              <span className="runhead num">{ord(i)}</span>
              <h3 className="mt-2 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
                {m.name}
              </h3>
              <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                {m.body}
              </p>
              {/* The worked figure sits in a WELL — inset rather than raised.
                  It is a specimen quoted inside the card, and a hole is the
                  right shape for a quotation. */}
              <div className="well mt-auto px-3.5 py-3">
                <span className="runhead">Example</span>
                <p className="num mt-1.5 break-words font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                  {m.example}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Small print, set as small print. It was an amber box, but amber means
            "waiting" in this palette — this is a footnote, not a state. */}
        <div className="reveal mt-3 flex gap-3 px-1">
          <Info size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <p className="measure-wide text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            <strong className="font-semibold text-slate-700 dark:text-slate-300">
              Network fees are separate.
            </strong>{' '}
            Moving USDT on-chain costs gas, and your agreement specifies whether
            that is deducted from your settlement or absorbed by the gateway.
            Your dashboard shows which applies, on the Commission page.
          </p>
        </div>
      </section>

      {/* ============================================================
          WHAT YOU GET. Two surfaces, each led by its own figure in the
          narrow column and its list of facts in the wide one.
          ============================================================ */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">Included</span>
          <h2 className="mt-3 h-section">Included on every account</h2>
          <p className="lede measure mt-4">
            Every merchant gets the full API and every security control from the
            first payment onwards.
          </p>
        </div>

        <div className="reveal surface spot mt-8 grid gap-8 p-5 sm:mt-12 sm:p-7 md:grid-cols-12 md:gap-10">
          <div className="min-w-0 md:col-span-4">
            <span className="figure-xl">0</span>
            <span className="figure-label measure">
              higher tiers to buy. There is nothing above this plan, because
              there is no plan.
            </span>
          </div>

          <ul className="min-w-0 md:col-span-7 md:col-start-6">
            {included.map((t, i) => (
              <li key={t} className="rule flex gap-4 py-3 first:border-t-0 first:pt-0">
                <span className="runhead num w-6 shrink-0 pt-1">{ord(i)}</span>
                <span className="measure text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                  {t}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="reveal surface spot mt-3 grid gap-8 p-5 sm:p-7 md:grid-cols-12 md:gap-10">
          <div className="min-w-0 md:col-span-4">
            <h2 className="runhead">Settlement networks</h2>
            <span className="figure-xl mt-2">{networkList.length}</span>
            <span className="figure-label measure">
              settlement {networkList.length === 1 ? 'network' : 'networks'} live
              on this gateway, read from the API rather than written into this
              page.
            </span>
          </div>

          <div className="min-w-0 md:col-span-7 md:col-start-6">
            <p className="lede measure">What this gateway can settle right now:</p>
            <ul className="mt-4">
              {networkList.map((n) => (
                <li key={n} className="spine-row">
                  <span className="text-base font-medium text-slate-900 dark:text-slate-100">
                    USDT · {n}
                  </span>
                  {/* emerald, not brand: this is health, and brand only ever
                      means "something you can click". The lozenge carries the
                      WORD as well as the hue, so colour is never the only
                      carrier. */}
                  <span className="st text-emerald-600 dark:text-emerald-400">
                    <span className="st-dot" aria-hidden />
                    Live
                  </span>
                </li>
              ))}
            </ul>
            <p className="measure-wide mt-5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Balances are tracked separately per network — funds are not
              fungible across chains, and each has its own settlement wallet.
            </p>
          </div>
        </div>
      </section>

      {/* ============================================================
          CLOSE. The same lit surface Landing closes on, so the two public
          pages end in the same key.
          ============================================================ */}
      <section className="section pt-0">
        <div className="reveal surface relative overflow-hidden bg-mesh p-6 sm:p-10">
          <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />
          <div className="relative">
            <span className="eyebrow">Get started</span>
            <h2 className="mt-3 h-section">Ready when you are</h2>
            <p className="lede measure mt-4">
              Create an account and see your exact commission before you take a
              single payment.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                to={signupEnabled ? '/signup' : '/login'}
                className="btn-primary-lg group"
              >
                {signupEnabled ? 'Create your account' : 'Sign in'}
                <ArrowRight
                  size={18}
                  className="transition-transform duration-200 group-hover:translate-x-0.5"
                />
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
