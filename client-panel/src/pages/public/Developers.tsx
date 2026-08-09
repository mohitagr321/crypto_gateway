import { Link } from 'react-router-dom';
import { ArrowRight, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import CodeBlock from '@/components/CodeBlock';
import { useReveal, revealDelay } from '@/lib/useReveal';

/**
 * Public developer guide — enough to evaluate the integration before signing up.
 *
 * The authenticated /docs page stays the full reference; this is the "can I
 * build on this?" page, and it is honest about the security trade-off between
 * the two key modes rather than quietly recommending the easy one.
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

const statuses = [
  ['waiting', 'Address issued, nothing received yet.'],
  ['confirming', 'Funds seen on-chain, waiting for confirmations.'],
  ['confirmed', 'Irreversible. This is when you fulfil the order.'],
  ['partial', 'Less than the expected amount arrived. Your call what to do.'],
  ['expired', 'The window closed with no payment.'],
  ['swept', 'Funds moved to the collection wallet and are ready to settle.'],
];

export default function Developers() {
  const revealRef = useReveal<HTMLDivElement>();

  return (
    <div ref={revealRef}>
      <section className="relative overflow-hidden bg-mesh">
        <div className="absolute inset-0 bg-grid" aria-hidden />
        <div className="section relative">
          <p className="reveal eyebrow">Developers</p>
          <h1 className="reveal mt-3 h-display" style={revealDelay(1)}>
            Integrate in <span className="text-gradient">an afternoon</span>
          </h1>
          <p className="reveal lede mt-5 max-w-2xl" style={revealDelay(2)}>
            One endpoint to create a payment, one webhook to know it landed. Below
            is genuinely everything you need for a working integration.
          </p>
        </div>
      </section>

      {/* ---- auth modes ---- */}
      <section className="section">
        <div className="reveal">
          <h2 className="h-section">Choose how your key authenticates</h2>
          <p className="lede mt-4 max-w-2xl">
            Both modes are supported. They are not equally strong, and the
            difference matters because this is a money API.
          </p>
        </div>

        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <div className="reveal glass-card p-7">
            <div className="flex items-center gap-2.5">
              <KeyRound size={18} className="text-slate-500" />
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                Bearer key
              </h3>
              <span className="chip">easiest</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              One opaque token in <code className="font-mono text-xs">X-Api-Key</code>.
              Nothing to sign. Good for a storefront plugin or a quick prototype.
            </p>
            <div className="mt-5">
              <CodeBlock tabs={[{ label: 'curl', code: SIMPLE_SNIPPET }]} />
            </div>
            <div className="mt-5 flex gap-2.5 rounded-lg bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                The token travels on every request, so it can end up in proxy logs
                and shell history. Because of that, bearer keys{' '}
                <strong>cannot be granted <code>payouts:write</code></strong> — a
                leaked one can create payments and read data, but cannot move funds.
                Pair it with an IP allowlist.
              </span>
            </div>
          </div>

          <div className="reveal glass-card p-7" style={revealDelay(1)}>
            <div className="flex items-center gap-2.5">
              <ShieldCheck size={18} className="text-brand-600 dark:text-brand-400" />
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-50">
                HMAC-signed
              </h3>
              <span className="chip">recommended</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              A public key id plus a secret that <em>never leaves your server</em>.
              Each request carries a signature over the timestamp and body, with a
              five-minute replay window.
            </p>
            <div className="mt-5">
              <CodeBlock tabs={[{ label: 'Node.js', code: HMAC_SNIPPET }]} />
            </div>
            <div className="mt-5 flex gap-2.5 rounded-lg bg-brand-50 p-3.5 text-xs leading-relaxed text-brand-800 dark:bg-brand-900/20 dark:text-brand-200">
              <ShieldCheck size={15} className="mt-0.5 shrink-0" />
              <span>
                Required for payouts. Intercepting a request reveals nothing reusable —
                the signature is bound to that timestamp and that exact body.
              </span>
            </div>
          </div>
        </div>

        <p className="reveal mt-8 text-sm text-slate-600 dark:text-slate-400">
          Either way, changing your settlement wallet, your password or your keys
          requires a signed-in dashboard session. No API key can do it, which is
          what stops a leaked credential from redirecting your money.
        </p>
      </section>

      {/* ---- webhooks ---- */}
      <section className="border-y border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40">
        <div className="section grid gap-12 lg:grid-cols-2 lg:items-start">
          <div className="reveal">
            <h2 className="h-section">Verify every webhook</h2>
            <p className="lede mt-4">
              We POST to your URL when a payment changes state, signed with your
              own per-account secret. The hex signature arrives both in the{' '}
              <code className="font-mono text-sm">signature</code> field of the
              body and in the{' '}
              <code className="font-mono text-sm">X-Gateway-Signature</code>{' '}
              header. Three rules:
            </p>
            <ol className="mt-6 space-y-4 text-sm text-slate-600 dark:text-slate-400">
              <li>
                <strong className="text-slate-900 dark:text-slate-100">Verify before you trust.</strong>{' '}
                Rebuild the body with <code className="font-mono text-xs">signature</code>{' '}
                set to <code className="font-mono text-xs">""</code>, HMAC that, and
                compare in constant time. An unverified webhook is an
                unauthenticated request from the internet.
              </li>
              <li>
                <strong className="text-slate-900 dark:text-slate-100">Be idempotent.</strong>{' '}
                Retries mean the same event can arrive more than once. Key your
                fulfilment on <code className="font-mono text-xs">orderId</code>.
              </li>
              <li>
                <strong className="text-slate-900 dark:text-slate-100">Ack fast.</strong>{' '}
                Return 2xx immediately and do the work asynchronously. Retries back
                off, and every attempt is logged in your dashboard.
              </li>
            </ol>
          </div>
          <div className="reveal" style={revealDelay(1)}>
            <CodeBlock tabs={[{ label: 'Express', code: WEBHOOK_SNIPPET }]} />
          </div>
        </div>
      </section>

      {/* ---- statuses ---- */}
      <section className="section">
        <div className="reveal">
          <h2 className="h-section">Payment statuses</h2>
          <p className="lede mt-4 max-w-2xl">
            Fulfil on <code className="font-mono text-sm">confirmed</code> — never
            earlier. Everything before it can still change.
          </p>
        </div>
        <div className="mt-10 overflow-x-auto">
          <table className="reveal w-full min-w-[34rem] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800">
                <th className="pb-3 pr-6 font-semibold text-slate-900 dark:text-slate-100">Status</th>
                <th className="pb-3 font-semibold text-slate-900 dark:text-slate-100">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {statuses.map(([s, meaning]) => (
                <tr key={s}>
                  <td className="py-3 pr-6 align-top">
                    <code className="font-mono text-xs text-brand-700 dark:text-brand-400">{s}</code>
                  </td>
                  <td className="py-3 text-slate-600 dark:text-slate-400">{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="reveal mt-12">
          <Link to="/signup" className="btn-primary-lg">
            Get an API key <ArrowRight size={18} />
          </Link>
        </div>
      </section>
    </div>
  );
}
