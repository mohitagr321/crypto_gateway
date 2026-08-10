import { Link } from 'react-router-dom';
import { ArrowRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import CodeBlock from '@/components/CodeBlock';
import { getSignupStatus } from '@/lib/api';
import { useReveal, revealDelay } from '@/lib/useReveal';

/**
 * Public developer guide — enough to evaluate the integration before signing up.
 *
 * The authenticated /docs page stays the full reference; this is the "can I
 * build on this?" page, and it is honest about the security trade-off between
 * the two key modes rather than quietly recommending the easy one.
 *
 * Set as a BROADSHEET. The page that used to live here opened with three lines
 * of centred type over a mesh and then ~190px of nothing before the first real
 * sentence, and put its two auth modes in a pair of glass cards — which reads as
 * "here are two options" when the whole point of the section is that one of them
 * is stronger than the other. So: the hero is anchored by an actual specimen of
 * the request; the auth modes are a ruled comparison table, because a table
 * makes a claim column-by-column where two cards only sit side by side; and the
 * statuses are a ruled definition list. Density and precision are what read as
 * competence to the audience for this page.
 */

const SIMPLE_SNIPPET = `curl -X POST https://your-gateway/api/v1/payments \\
  -H "X-Api-Key: ak_live_3e9e8336ffbc…" \\
  -H "Idempotency-Key: order-1042" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"49.90","orderId":"order-1042"}'`;

const HMAC_SNIPPET = `import crypto from 'crypto';

const ts   = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ amount: '49.90', orderId: 'order-1042' });

// The signature covers the timestamp AND the exact raw body.
const signature = crypto
  .createHmac('sha256', process.env.GATEWAY_API_SECRET)
  .update(\`\${ts}.\${body}\`)
  .digest('hex');

await fetch('https://your-gateway/api/v1/payments', {
  method: 'POST',
  headers: {
    'X-Api-Key':       process.env.GATEWAY_API_KEY,   // pk_live_…
    'X-Timestamp':     ts,
    'X-Signature':     signature,
    'Idempotency-Key': 'order-1042',
    'Content-Type':    'application/json',
  },
  body,   // must be these exact bytes — re-serialising breaks the signature
});`;

const WEBHOOK_SNIPPET = `app.post('/webhooks/gateway',
  express.raw({ type: 'application/json' }),   // raw bytes, not parsed JSON
  (req, res) => {
    const event = JSON.parse(req.body.toString());

    // The signature travels INSIDE the body, and it was computed over that
    // same body with the signature field blanked. So blank it and re-serialise
    // — do NOT hash the raw bytes, they already contain the signature.
    const unsigned = JSON.stringify({ ...event, signature: '' });
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(unsigned)
      .digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(event.signature ?? '', 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).end();
    }

    if (event.event === 'payment.confirmed') {
      // Idempotent: this may be delivered more than once.
      fulfilOrder(event.orderId);
    }
    res.status(200).end();   // ack fast; retries stop on 2xx
  });`;

/**
 * The comparison, row by row. A table rather than two cards on purpose: the
 * reader can run their eye down one attribute and see both answers at once,
 * which is the only layout that actually makes the trade-off legible.
 */
const AUTH_ROWS = [
  {
    key: 'sends',
    label: 'What you send',
    bearer: (
      <>
        One opaque token in <code className="code">X-Api-Key</code>. Nothing to
        sign.
      </>
    ),
    hmac: (
      <>
        A public key id in <code className="code">X-Api-Key</code>, plus{' '}
        <code className="code">X-Timestamp</code> and{' '}
        <code className="code">X-Signature</code>.
      </>
    ),
  },
  {
    key: 'secret',
    label: 'Where the secret lives',
    bearer: (
      <>
        In the request. It travels on every call, so it can end up in proxy logs
        and shell history.
      </>
    ),
    hmac: (
      <>
        On your server. The secret signs the request and{' '}
        <em>never leaves the machine</em>.
      </>
    ),
  },
  {
    key: 'intercepted',
    label: 'If a request is intercepted',
    bearer: <>The token is the credential. Whoever has it can repeat the call.</>,
    hmac: (
      <>
        Nothing reusable — the signature is bound to that timestamp and those
        exact bytes.
      </>
    ),
  },
  {
    key: 'replay',
    label: 'Replay window',
    bearer: <>None.</>,
    hmac: <>Five minutes, then the timestamp is refused.</>,
  },
  {
    key: 'payouts',
    label: <code className="code">payouts:write</code>,
    bearer: (
      <>
        Cannot be granted. A leaked bearer key can create payments and read data,
        but it cannot move funds.
      </>
    ),
    hmac: <>Required. This is the only mode that can pay money out.</>,
  },
  {
    key: 'when',
    label: 'Reach for it when',
    bearer: (
      <>
        You are wiring up a storefront plugin or a prototype. Pair it with an IP
        allowlist.
      </>
    ),
    hmac: <>Anything that moves money, and anything you run in production.</>,
  },
];

const WEBHOOK_RULES = [
  {
    title: 'Verify before you trust.',
    body: (
      <>
        Rebuild the body with <code className="code">signature</code> set to{' '}
        <code className="code">""</code>, HMAC that, and compare in constant
        time. An unverified webhook is an unauthenticated request from the
        internet.
      </>
    ),
  },
  {
    title: 'Be idempotent.',
    body: (
      <>
        Retries mean the same event can arrive more than once. Key your
        fulfilment on <code className="code">orderId</code>.
      </>
    ),
  },
  {
    title: 'Ack fast.',
    body: (
      <>
        Return 2xx immediately and do the work asynchronously. Retries back off,
        and every attempt is logged in your dashboard.
      </>
    ),
  },
];

/**
 * `tone` is the state palette, not decoration: amber is waiting on something,
 * emerald is money that has actually arrived, slate is a dead end. Never the
 * only carrier of the meaning — the state's own name sits next to it.
 */
const statuses = [
  { name: 'waiting', tone: 'bg-amber-500', meaning: 'Address issued, nothing received yet.' },
  {
    name: 'confirming',
    tone: 'bg-amber-500',
    meaning: 'Funds seen on-chain, waiting for confirmations.',
  },
  {
    name: 'confirmed',
    tone: 'bg-emerald-500',
    meaning: 'Irreversible. This is when you fulfil the order.',
  },
  {
    name: 'partial',
    tone: 'bg-amber-500',
    meaning: 'Less than the expected amount arrived. Your call what to do.',
  },
  { name: 'expired', tone: 'bg-slate-400', meaning: 'The window closed with no payment.' },
  {
    name: 'swept',
    tone: 'bg-emerald-600',
    meaning: 'Funds moved to the collection wallet and are ready to settle.',
  },
];

export default function Developers() {
  const revealRef = useReveal<HTMLDivElement>();

  // Same rule the rest of the public surface follows: when the gateway runs
  // with SIGNUP_ENABLED=false there is no /signup to send anyone to, so the
  // closing CTA points at sign-in instead of a door that 404s. Same query key
  // and staleTime as Landing, Pricing and the shell, so this is served from
  // the cache rather than costing another request.
  const { data: signupEnabled } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  return (
    <div ref={revealRef}>
      {/* ---- masthead + the specimen that anchors it ---- */}
      <section className="relative overflow-hidden bg-mesh">
        <div className="absolute inset-0 bg-grid" aria-hidden />
        <div className="section relative pb-12 sm:pb-16">
          <div className="reveal rule-strong flex items-baseline justify-between gap-4 pt-4">
            <span className="runhead">Developers</span>
            <span className="runhead">API v1</span>
          </div>

          <div className="mt-8 grid gap-x-12 gap-y-10 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <h1 className="reveal h-display" style={revealDelay(1)}>
                Integrate in an afternoon
              </h1>
              <p className="reveal lede measure mt-6" style={revealDelay(2)}>
                One endpoint to create a payment, one webhook to know it landed.
                Below is genuinely everything you need for a working
                integration.
              </p>
            </div>

            <div className="reveal lg:col-span-7" style={revealDelay(3)}>
              <div className="rule flex flex-wrap items-baseline justify-between gap-3 pt-4">
                <span className="runhead">Specimen — create a payment</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Bearer mode
                </span>
              </div>
              <div className="mt-4">
                <CodeBlock
                  tabs={[{ label: 'curl', code: SIMPLE_SNIPPET }]}
                  title="POST /api/v1/payments"
                />
              </div>
              <p className="mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Send the same <code className="code">Idempotency-Key</code>{' '}
                twice and the second call returns the first response verbatim,
                so a retry after a timeout cannot charge a customer twice.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---- auth modes, as a comparison rather than a pair of cards ---- */}
      <section className="section pt-14 sm:pt-16">
        <div className="grid gap-x-12 gap-y-10 md:grid-cols-12">
          <aside className="reveal col-aside md:col-span-3">
            <span className="runhead">Authentication</span>
            <p className="measure mt-4">
              Both modes are supported. They are not equally strong, and the
              difference matters because this is a money API.
            </p>
            <span className="figure-xl mt-10">5</span>
            <span className="figure-label">
              minute replay window on a signed request. Capture one in flight
              and by the time you replay it, it has already expired.
            </span>
          </aside>

          <div className="md:col-span-9">
            <h2 className="reveal h-section">Choose how your key authenticates</h2>

            <div className="reveal mt-8 overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead>
                  <tr>
                    <th
                      scope="col"
                      className="w-[20%] border-b-2 border-slate-900 pb-3 pr-6 align-bottom dark:border-slate-100"
                    >
                      <span className="runhead">Mode</span>
                    </th>
                    <th
                      scope="col"
                      className="w-[40%] border-b-2 border-slate-900 pb-3 pr-6 align-bottom dark:border-slate-100"
                    >
                      <span className="block text-base font-semibold text-slate-900 dark:text-slate-50">
                        Bearer key
                      </span>
                      <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
                        The easy one
                      </span>
                    </th>
                    <th
                      scope="col"
                      className="w-[40%] border-b-2 border-slate-900 pb-3 align-bottom dark:border-slate-100"
                    >
                      <span className="block text-base font-semibold text-slate-900 dark:text-slate-50">
                        HMAC-signed
                      </span>
                      <span className="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
                        Recommended
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {AUTH_ROWS.map((row) => (
                    <tr key={row.key} className="align-top">
                      <th
                        scope="row"
                        className="py-4 pr-6 font-medium text-slate-900 dark:text-slate-100"
                      >
                        {row.label}
                      </th>
                      <td className="py-4 pr-6 leading-relaxed text-slate-600 dark:text-slate-400">
                        {row.bearer}
                      </td>
                      <td className="py-4 leading-relaxed text-slate-600 dark:text-slate-400">
                        {row.hmac}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-10 grid gap-x-12 gap-y-6 sm:grid-cols-2">
              <div className="reveal rule pt-5">
                <span className="runhead flex items-center gap-2">
                  <ShieldAlert
                    size={14}
                    className="text-amber-600 dark:text-amber-400"
                    aria-hidden
                  />
                  What it costs you
                </span>
                <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  A bearer token is only as safe as every hop it crosses. That is
                  why the scope is capped rather than left to your judgement —
                  the key literally cannot be issued with payout permission.
                </p>
              </div>
              <div className="reveal rule pt-5" style={revealDelay(1)}>
                <span className="runhead flex items-center gap-2">
                  <ShieldCheck
                    size={14}
                    className="text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                  What it buys you
                </span>
                <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  The secret is used, never sent. Every request proves it knows
                  the secret without revealing it, and that proof is worthless
                  five minutes later.
                </p>
              </div>
            </div>

            <div className="reveal mt-12">
              <div className="rule flex flex-wrap items-baseline justify-between gap-3 pt-4">
                <span className="runhead">Specimen — signing a request</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Same call as above, plus two headers
                </span>
              </div>
              <div className="mt-4">
                <CodeBlock
                  tabs={[{ label: 'Node.js', code: HMAC_SNIPPET }]}
                  title="POST /api/v1/payments"
                />
              </div>
            </div>

            <p className="reveal measure mt-10 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              Either way, changing your settlement wallet, your password or your
              keys requires a signed-in dashboard session. No API key can do it,
              which is what stops a leaked credential from redirecting your
              money.
            </p>
          </div>
        </div>
      </section>

      {/* ---- webhooks: prose on a measure, the handler bled out beside it ---- */}
      <section className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="mx-auto grid w-full max-w-6xl gap-x-12 gap-y-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-12 lg:items-start">
          <div className="lg:col-span-5">
            <span className="reveal runhead">Webhooks</span>
            <h2 className="reveal mt-4 h-section" style={revealDelay(1)}>
              Verify every webhook
            </h2>
            <p className="reveal lede measure mt-5" style={revealDelay(2)}>
              We POST to your URL when a payment changes state, signed with your
              own per-account secret. The hex signature arrives both in the{' '}
              <code className="code">signature</code> field of the body and in
              the <code className="code">X-Gateway-Signature</code> header.
            </p>

            <div className="reveal rule mt-10 pt-6">
              <span className="figure-xl">{WEBHOOK_RULES.length}</span>
              <span className="figure-label">
                rules for handling a delivery. Each one is load-bearing on its
                own, and the one you skip is the one that bites in production.
              </span>
            </div>

            <ol className="mt-8">
              {WEBHOOK_RULES.map((rule, i) => (
                <li key={rule.title} className="reveal rule py-5" style={revealDelay(i)}>
                  <div className="flex gap-4">
                    <span className="mt-0.5 shrink-0 text-xs font-medium tabular-nums text-slate-400 dark:text-slate-500">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                      <strong className="font-semibold text-slate-900 dark:text-slate-100">
                        {rule.title}
                      </strong>{' '}
                      {rule.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="rule" />
          </div>

          {/* Bled to the container edge: the specimen is the widest thing on the
              page and gets to break the measure rather than be squeezed into it. */}
          <div className="reveal lg:col-span-7 lg:-mr-8" style={revealDelay(1)}>
            <div className="rule flex flex-wrap items-baseline justify-between gap-3 pt-4 lg:pr-8">
              <span className="runhead">Specimen — receiving handler</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Express
              </span>
            </div>
            <div className="mt-4">
              <CodeBlock
                tabs={[{ label: 'Express', code: WEBHOOK_SNIPPET }]}
                title="POST /webhooks/gateway"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ---- statuses, as a ruled definition list ---- */}
      <section className="section">
        <div className="grid gap-x-12 gap-y-10 md:grid-cols-12">
          <aside className="reveal col-aside md:col-span-3">
            <span className="runhead">Payment statuses</span>
            <span className="figure-xl mt-6">1</span>
            <span className="figure-label">
              of the {statuses.length} states below is the one you fulfil on:{' '}
              <code className="font-mono text-slate-700 dark:text-slate-300">
                confirmed
              </code>
              . Everything before it can still change.
            </span>
          </aside>

          <div className="md:col-span-9">
            <h2 className="reveal h-section">The states a payment moves through</h2>

            <dl className="mt-8">
              {statuses.map((status, i) => (
                <div
                  key={status.name}
                  className="reveal rule grid grid-cols-1 gap-1 py-4 sm:grid-cols-12 sm:gap-6"
                  style={revealDelay(i)}
                >
                  <dt className="flex items-center gap-2.5 sm:col-span-4">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${status.tone}`}
                      aria-hidden
                    />
                    <code className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                      {status.name}
                    </code>
                  </dt>
                  <dd className="measure text-sm leading-relaxed text-slate-600 sm:col-span-8 dark:text-slate-400">
                    {status.meaning}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="rule" />
          </div>
        </div>
      </section>

      {/* ---- closing folio ---- */}
      <section className="section pt-0">
        <div className="reveal rule-strong flex flex-col gap-6 pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
            Keys are issued from the dashboard and shown exactly once. Start on a
            bearer key if you want something working today — it cannot move
            funds, so the blast radius of losing it is bounded.
          </p>
          <Link
            to={signupEnabled ? '/signup' : '/login'}
            className="btn-primary-lg shrink-0"
          >
            {signupEnabled ? 'Get an API key' : 'Sign in'}{' '}
            <ArrowRight size={18} />
          </Link>
        </div>
      </section>
    </div>
  );
}
