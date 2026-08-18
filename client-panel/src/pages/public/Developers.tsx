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
 * DENSITY AND PRECISION ARE WHAT READ AS COMPETENCE to this page's audience, so
 * the conversion to surfaces was done without loosening anything: the auth modes
 * are still a column-by-column comparison (two cards would say "here are two
 * options" when the point of the section is that one of them is stronger), the
 * statuses are still a ruled definition list, and the specimens are still real
 * code rather than screenshots. What changed is that each of those now sits on
 * its own raised, rim-lit plane instead of being fenced off by a hairline.
 *
 * THE COMPARISON HAS A REAL MOBILE SHAPE. It used to be a 44rem table inside an
 * `overflow-x-auto`, which is contained but hands a phone reader a sideways drag
 * through the single densest thing on the public site. Below `md` the same six
 * rows render as stacked blocks — one per attribute, both answers underneath it
 * — which is the reading order the table was encoding anyway.
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
 * only carrier of the meaning — the state's own name sits next to it, and the
 * name is the literal API value, which is why it is set in code type and left
 * lowercase rather than dressed as a lozenge.
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
      {/* Static mesh, not the animated aurora — see the note on Pricing's hero.
          The shell's depth field is already drifting behind this. */}
      <section className="relative isolate overflow-hidden bg-mesh">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-grid" aria-hidden />

        <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 pb-14 pt-8 sm:px-8 sm:pb-20 sm:pt-14 lg:grid-cols-12 lg:items-center lg:gap-12">
          <div className="min-w-0 lg:col-span-5">
            <div className="reveal flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="eyebrow">Developers</span>
              <span className="chip num">API v1</span>
            </div>
            <h1 className="reveal mt-6 h-display" style={revealDelay(1)}>
              Integrate in an afternoon
            </h1>
            <p className="reveal lede measure mt-5" style={revealDelay(2)}>
              One endpoint to create a payment, one webhook to know it landed.
              Below is genuinely everything you need for a working integration.
            </p>
          </div>

          <div className="reveal min-w-0 lg:col-span-7" style={revealDelay(3)}>
            <Specimen title="Specimen — create a payment" note="Bearer mode">
              <CodeBlock
                tabs={[{ label: 'curl', code: SIMPLE_SNIPPET }]}
                title="POST /api/v1/payments"
              />
              <p className="measure mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                Send the same <code className="code">Idempotency-Key</code> twice
                and the second call returns the first response verbatim, so a
                retry after a timeout cannot charge a customer twice.
              </p>
            </Specimen>
          </div>
        </div>
      </section>

      {/* ---- auth modes, as a comparison rather than a pair of cards ---- */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">Authentication</span>
          <h2 className="mt-3 h-section">Choose how your key authenticates</h2>
          <p className="lede measure mt-4">
            Both modes are supported. They are not equally strong, and the
            difference matters because this is a money API.
          </p>
        </div>

        {/* md and up: the real comparison. `min-w` plus a scroller is kept as a
            last-resort safety net for a narrow tablet — six prose columns
            genuinely cannot compress past a point — but the phone never reaches
            it, because the stacked variant below takes over first. */}
        <div className="reveal surface mt-8 hidden overflow-x-auto px-4 py-1 sm:mt-12 sm:px-5 md:block">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="w-[22%] border-b border-[var(--line)] pb-3 pr-6 align-bottom"
                >
                  <span className="runhead">Mode</span>
                </th>
                <th
                  scope="col"
                  className="w-[39%] border-b border-[var(--line)] pb-3 pr-6 align-bottom"
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
                  className="w-[39%] border-b border-[var(--line)] pb-3 align-bottom"
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
            {/* `divide-y` rather than a `.rule` on every cell: it puts the
                hairline BETWEEN rows only, so the first body row does not
                double up against the header's own bottom border. */}
            <tbody className="divide-y divide-[var(--line-soft)]">
              {AUTH_ROWS.map((row) => (
                <tr key={row.key} className="align-top">
                  <th
                    scope="row"
                    className="py-4 pr-6 text-left font-medium text-slate-900 dark:text-slate-100"
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

        {/* Below md: one surface per attribute, both answers stacked under it.
            The column headings become row labels, which is exactly the reading
            the table was encoding — and it fits 320px with no drag. */}
        <div className="mt-8 grid gap-3 md:hidden">
          {AUTH_ROWS.map((row, i) => (
            <div
              key={row.key}
              className="reveal surface min-w-0 p-4"
              style={revealDelay(i % 3)}
            >
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {row.label}
              </h3>
              <dl className="mt-3">
                <div className="rule pt-3 first:border-t-0 first:pt-0">
                  <dt className="runhead">Bearer key</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {row.bearer}
                  </dd>
                </div>
                <div className="rule mt-3 pt-3">
                  <dt className="runhead">HMAC-signed · recommended</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    {row.hmac}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="reveal surface spot min-w-0 p-5 sm:p-6">
            <span className="figure-xl">5</span>
            <span className="figure-label measure">
              minute replay window on a signed request. Capture one in flight and
              by the time you replay it, it has already expired.
            </span>
          </div>

          <div className="reveal surface spot min-w-0 p-5 sm:p-6" style={revealDelay(1)}>
            <span className="runhead flex items-center gap-2">
              <ShieldAlert
                size={14}
                className="shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden
              />
              What it costs you
            </span>
            <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              A bearer token is only as safe as every hop it crosses. That is why
              the scope is capped rather than left to your judgement — the key
              literally cannot be issued with payout permission.
            </p>
          </div>

          <div className="reveal surface spot min-w-0 p-5 sm:p-6" style={revealDelay(2)}>
            <span className="runhead flex items-center gap-2">
              <ShieldCheck
                size={14}
                className="shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
              What it buys you
            </span>
            <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              The secret is used, never sent. Every request proves it knows the
              secret without revealing it, and that proof is worthless five
              minutes later.
            </p>
          </div>
        </div>

        <div className="reveal mt-3">
          <Specimen
            title="Specimen — signing a request"
            note="Same call as above, plus two headers"
          >
            <CodeBlock
              tabs={[{ label: 'Node.js', code: HMAC_SNIPPET }]}
              title="POST /api/v1/payments"
            />
          </Specimen>
        </div>

        <p className="reveal measure-wide mt-6 px-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Either way, changing your settlement wallet, your password or your keys
          requires a signed-in dashboard session. No API key can do it, which is
          what stops a leaked credential from redirecting your money.
        </p>
      </section>

      {/* ---- webhooks: the rules on a measure, the handler beside them ---- */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">Webhooks</span>
          <h2 className="mt-3 h-section">Verify every webhook</h2>
          <p className="lede measure mt-4">
            We POST to your URL when a payment changes state, signed with your
            own per-account secret. The hex signature arrives both in the{' '}
            <code className="code">signature</code> field of the body and in the{' '}
            <code className="code">X-Gateway-Signature</code> header.
          </p>
        </div>

        <div className="mt-8 grid gap-3 sm:mt-12 lg:grid-cols-12 lg:items-start">
          <div className="reveal surface spot min-w-0 p-5 sm:p-6 lg:col-span-5">
            <span className="figure-xl">{WEBHOOK_RULES.length}</span>
            <span className="figure-label measure">
              rules for handling a delivery. Each one is load-bearing on its own,
              and the one you skip is the one that bites in production.
            </span>

            <ol className="mt-6">
              {WEBHOOK_RULES.map((rule, i) => (
                <li key={rule.title} className="rule flex gap-4 py-4 first:border-t-0">
                  <span className="num mt-0.5 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                    <strong className="font-semibold text-slate-900 dark:text-slate-100">
                      {rule.title}
                    </strong>{' '}
                    {rule.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>

          <div className="reveal min-w-0 lg:col-span-7" style={revealDelay(1)}>
            <Specimen title="Specimen — receiving handler" note="Express">
              <CodeBlock
                tabs={[{ label: 'Express', code: WEBHOOK_SNIPPET }]}
                title="POST /webhooks/gateway"
              />
            </Specimen>
          </div>
        </div>
      </section>

      {/* ---- statuses, as a ruled definition list on one surface ---- */}
      <section className="section pt-0">
        <div className="reveal">
          <span className="eyebrow">Payment statuses</span>
          <h2 className="mt-3 h-section">The states a payment moves through</h2>
          <p className="lede measure mt-4">
            One of the {statuses.length} below is the one you fulfil on:{' '}
            <code className="code">confirmed</code>. Everything before it can
            still change.
          </p>
        </div>

        <dl className="reveal surface mt-8 px-4 py-1 sm:mt-12 sm:px-5">
          {statuses.map((status) => (
            <div
              key={status.name}
              className="rule grid grid-cols-1 gap-1 py-3.5 first:border-t-0 sm:grid-cols-12 sm:gap-6"
            >
              <dt className="flex items-center gap-2.5 sm:col-span-4">
                {/* The 500 step is the ramp's documented DOT-AND-FILL step, and
                    it is never the only carrier: the state's own name is set
                    right beside it in code type. */}
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
      </section>

      {/* ---- closing folio, on the same lit surface Landing and Pricing close
              on, so the three public pages end in one key ---- */}
      <section className="section pt-0">
        <div className="reveal surface relative overflow-hidden bg-mesh p-6 sm:p-10">
          <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden />
          <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              Keys are issued from the dashboard and shown exactly once. Start on
              a bearer key if you want something working today — it cannot move
              funds, so the blast radius of losing it is bounded.
            </p>
            <Link
              to={signupEnabled ? '/signup' : '/login'}
              className="btn-primary-lg shrink-0"
            >
              {signupEnabled ? 'Get an API key' : 'Sign in'}
              <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * A labelled code specimen.
 *
 * The header is a running head and a note ranged against it — the same two-part
 * caption the page used before, but it now belongs to a surface rather than
 * hanging off a hairline. CodeBlock brings its own dark frame and radius, so the
 * wrapper deliberately does NOT add a second one: a bordered box inside a
 * bordered box is the "mixed kit" look the radius scale exists to prevent.
 */
function Specimen({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="surface min-w-0 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="runhead">{title}</h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">{note}</span>
      </div>
      {children}
    </div>
  );
}
