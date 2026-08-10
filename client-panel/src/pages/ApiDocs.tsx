import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { API_BASE_URL, getAssets } from '@/lib/api';
import PageHeader from '@/components/PageHeader';
import CodeBlock from '@/components/CodeBlock';

/**
 * The authenticated API reference.
 *
 * Two things in here were previously WRONG in a way that guaranteed a failed
 * integration, and both are called out at the point of use rather than fixed
 * silently, because merchants have copied the old versions:
 *
 *   1. Request signing. This page used to sign `timestamp + body` with a
 *      MILLISECOND timestamp. The server signs `${timestamp}.${rawBody}` with a
 *      SECOND timestamp (backend/src/middleware/auth.ts) — so every request
 *      built from the old snippets returned 401.
 *   2. Webhook verification. This page used to HMAC the raw request body. The
 *      signature is computed over the body with the `signature` field blanked
 *      (backend/src/services/webhookService.ts), so hashing the raw bytes never
 *      matched.
 *
 * Anything added here must be checked against the route it documents. A docs
 * page that is confidently wrong costs more than no docs page.
 *
 * ---------------------------------------------------------------------------
 * SET AS A REFERENCE WORK. The prose is unchanged; the STRUCTURE around it is
 * what was rebuilt, because at 900 lines this page's real failure was that
 * everything looked equally important:
 *
 *   - The contents column is now a numbered index with a live position rail.
 *     Brand on the rail is the sanctioned "active nav" use — it marks the one
 *     entry you can see rather than decorating all eight.
 *   - Sections are numbered and opened by a hairline, so the reader always
 *     knows how far in they are. The masthead's heavy rule is the only strong
 *     stroke on the page and is not doubled by the first section.
 *   - The four reference tables are LEDGERS (`.ledger`), the same primitive
 *     DataTable renders through, instead of four cards with tinted header bars.
 *     Column headers sit over an ink rule; rows are separated by hairlines.
 *   - Callouts are ruled notes with a word, not tinted rounded boxes. Amber and
 *     red still mean what they mean everywhere else in the product, and each
 *     one now ships a label so the meaning survives in greyscale.
 *   - Every code specimen is introduced by a running head naming what it is,
 *     and the two long ones carry the route in the block's own chrome.
 *
 * MOTION: none. The one moving part is the position rail, which is driven by an
 * IntersectionObserver and changes a colour — no transform, no entrance, no
 * loop. The loading placeholder is `.ghost`, not `.skeleton`: this is a
 * dashboard route and `.skeleton` shimmers forever.
 */

const BASE = API_BASE_URL;

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

const createPaymentTabs = [
  {
    label: 'curl',
    code: `# Signed string is "<timestamp>.<rawBody>" — note the DOT — and the
# timestamp is unix SECONDS, not milliseconds.
API_KEY="pk_live_your_key"
API_SECRET="your_api_secret"
TS=$(date +%s)
BODY='{"amount":"50.00","orderId":"order_789","network":"BEP20","asset":"USDT"}'
SIG=$(printf "%s.%s" "$TS" "$BODY" | openssl dgst -sha256 -hmac "$API_SECRET" | awk '{print $2}')

curl -X POST "${BASE}/payments" \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $API_KEY" \\
  -H "X-Timestamp: $TS" \\
  -H "X-Signature: $SIG" \\
  -H "Idempotency-Key: order_789" \\
  -d "$BODY"`,
  },
  {
    label: 'JavaScript',
    code: `import crypto from 'node:crypto';

const BASE = '${BASE}';

async function createPayment() {
  // Unix SECONDS. A millisecond timestamp is outside the 5-minute replay
  // window by a factor of 1000 and is rejected.
  const timestamp = Math.floor(Date.now() / 1000).toString();

  // Serialize ONCE and send these exact bytes. Re-stringifying (which axios
  // does by default) changes the body and breaks the signature.
  const body = JSON.stringify({
    amount: '50.00',
    orderId: 'order_789',
    network: 'BEP20',
    asset: 'USDT',
  });

  const signature = crypto
    .createHmac('sha256', process.env.API_SECRET)
    .update(\`\${timestamp}.\${body}\`)   // dot separator
    .digest('hex');

  const res = await fetch(\`\${BASE}/payments\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.API_KEY,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'Idempotency-Key': 'order_789',
    },
    body,
  });

  if (!res.ok) throw new Error(\`Gateway error \${res.status}\`);
  return res.json();
}`,
  },
  {
    label: 'Python',
    code: `import hmac, hashlib, json, time, requests

BASE = "${BASE}"
API_KEY = "pk_live_your_key"
API_SECRET = "your_api_secret"

def create_payment():
    timestamp = str(int(time.time()))          # SECONDS
    body = json.dumps({
        "amount": "50.00",
        "orderId": "order_789",
        "network": "BEP20",
        "asset": "USDT",
    }, separators=(",", ":"))                  # compact; sign what you send

    signature = hmac.new(
        API_SECRET.encode(),
        f"{timestamp}.{body}".encode(),        # dot separator
        hashlib.sha256,
    ).hexdigest()

    resp = requests.post(
        f"{BASE}/payments",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Api-Key": API_KEY,
            "X-Timestamp": timestamp,
            "X-Signature": signature,
            "Idempotency-Key": "order_789",
        },
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()`,
  },
  {
    label: 'PHP',
    code: `<?php
$base = "${BASE}";
$apiKey = "pk_live_your_key";
$apiSecret = "your_api_secret";

$timestamp = (string) time();                  // SECONDS
$body = json_encode([
    "amount" => "50.00",
    "orderId" => "order_789",
    "network" => "BEP20",
    "asset" => "USDT",
], JSON_UNESCAPED_SLASHES);

$signature = hash_hmac("sha256", "$timestamp.$body", $apiSecret);  // dot

$ch = curl_init("$base/payments");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Content-Type: application/json",
        "X-Api-Key: $apiKey",
        "X-Timestamp: $timestamp",
        "X-Signature: $signature",
        "Idempotency-Key: order_789",
    ],
]);
echo curl_exec($ch);
curl_close($ch);`,
  },
];

const bearerSnippet = `# Bearer mode: the token IS the secret. Nothing to sign.
curl -X POST "${BASE}/payments" \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: ak_live_your_token" \\
  -H "Idempotency-Key: order_789" \\
  -d '{"amount":"50.00","orderId":"order_789"}'`;

const responseCrypto = `{
  "paymentId": "pay_01HZY...",
  "orderId": "order_789",
  "amount": "50.00",
  "amountReceived": "0",
  "currency": "USDT",
  "asset": "USDT",
  "network": "BEP20",
  "address": "0xabc...",
  "qrCode": "data:image/png;base64,...",
  "status": "waiting",
  "confirmations": 0,
  "txHash": null,
  "expiresAt": "2026-08-08T12:30:00.000Z",
  "createdAt": "2026-08-08T12:00:00.000Z"
}`;

const responseFiat = `{
  "paymentId": "pay_01HZZ...",
  "orderId": "order_790",
  "amount": "53.85",
  "amountReceived": "0",
  "currency": "USDT",
  "asset": "USDT",
  "network": "TRC20",
  "address": "TXk...",
  "status": "waiting",
  "confirmations": 0,
  "txHash": null,

  // Present ONLY when priced in fiat. The rate is locked at creation
  // and never revisited, so this is what you reconcile against.
  "fiat": {
    "currency": "EUR",
    "amount": "49.90",
    "rate": "1.0791",
    "source": "coingecko",
    "lockedAt": "2026-08-08T12:00:00.000Z"
  },

  "expiresAt": "2026-08-08T12:30:00.000Z",
  "createdAt": "2026-08-08T12:00:00.000Z"
}`;

const fiatRequest = `{
  "fiatAmount":   "49.90",
  "fiatCurrency": "EUR",
  "orderId":      "order_790",
  "network":      "TRC20",
  "asset":        "USDT"
}`;

const webhookVerifyTabs = [
  {
    label: 'JavaScript',
    code: `import crypto from 'node:crypto';

// Use a RAW body parser so you can parse it yourself.
app.post('/webhooks/gateway',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const event = JSON.parse(req.body.toString());

    // The signature is computed over this same body with the "signature"
    // field set to "". Blank it and re-serialize — do NOT hash the raw
    // bytes, because those already contain the real signature.
    const unsigned = JSON.stringify({ ...event, signature: '' });

    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(unsigned)
      .digest('hex');

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(event.signature ?? '', 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).send('bad signature');
    }

    // event: payment.confirmed | paymentId | orderId | amount | txHash | status
    // Fulfil idempotently — retries mean this can arrive more than once.
    res.sendStatus(200);
  });`,
  },
  {
    label: 'Python',
    code: `import hmac, hashlib, json
from flask import Flask, request, abort

app = Flask(__name__)
WEBHOOK_SECRET = "your_webhook_secret"

@app.post("/webhooks/gateway")
def webhook():
    event = json.loads(request.get_data())
    received = event.get("signature", "")

    # Blank the signature and re-serialize in the SAME compact form the
    # gateway used (no spaces), preserving key order.
    unsigned = json.dumps({**event, "signature": ""}, separators=(",", ":"))

    expected = hmac.new(
        WEBHOOK_SECRET.encode(), unsigned.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected, received):
        abort(401)

    # event => event, paymentId, orderId, amount, txHash, status
    return "", 200`,
  },
  {
    label: 'PHP',
    code: `<?php
$secret = "your_webhook_secret";
$event = json_decode(file_get_contents("php://input"), true);
$received = $event["signature"] ?? "";

// Blank the signature, keep key order, re-encode compactly.
$unsigned = $event;
$unsigned["signature"] = "";
$expected = hash_hmac(
    "sha256",
    json_encode($unsigned, JSON_UNESCAPED_SLASHES),
    $secret
);

if (!hash_equals($expected, $received)) {
    http_response_code(401);
    exit("bad signature");
}

// $event => event, paymentId, orderId, amount, txHash, status
http_response_code(200);`,
  },
];

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** Every merchant-reachable endpoint. Admin routes are deliberately excluded. */
const ENDPOINTS: { group: string; rows: [string, string, string][] }[] = [
  {
    group: 'Payments',
    rows: [
      ['POST', '/payments', 'Create a payment and get a deposit address.'],
      ['GET', '/payments', 'List payments. Paginated.'],
      ['GET', '/payments/{id}', 'Fetch one payment by id.'],
      ['GET', '/balance', 'Settled balance. `?all=true` for one row per (network, asset).'],
    ],
  },
  {
    group: 'Payment links & checkout',
    rows: [
      ['GET', '/payment-links', 'List your hosted-checkout links.'],
      ['POST', '/payment-links', 'Create a hosted-checkout link.'],
      ['GET', '/pay/{token}', 'PUBLIC — link details for the checkout page.'],
      ['POST', '/pay/{token}/payments', 'PUBLIC — customer starts a payment.'],
      ['GET', '/pay/{token}/payments/{id}', 'PUBLIC — poll payment state.'],
      ['GET', '/pay/{token}/invoice', 'PUBLIC — invoice behind a link, if any.'],
    ],
  },
  {
    group: 'Invoices',
    rows: [
      ['GET', '/invoices', 'List invoices. Filter with `?status=`.'],
      ['POST', '/invoices', 'Create an invoice.'],
      ['GET', '/invoices/{id}', 'Fetch one invoice.'],
      ['POST', '/invoices/{id}/send', 'Email the invoice to the customer.'],
      ['POST', '/invoices/{id}/void', 'Void an unpaid invoice.'],
    ],
  },
  {
    group: 'Subscriptions',
    rows: [
      ['GET', '/subscriptions', 'List subscriptions.'],
      ['POST', '/subscriptions', 'Create a recurring subscription.'],
      ['GET', '/subscriptions/{id}', 'Fetch one subscription.'],
      ['GET', '/subscriptions/{id}/invoices', 'Invoices generated by it.'],
      ['POST', '/subscriptions/{id}/pause', 'Stop generating invoices.'],
      ['POST', '/subscriptions/{id}/resume', 'Resume generating invoices.'],
      ['POST', '/subscriptions/{id}/cancel', 'Cancel permanently.'],
    ],
  },
  {
    group: 'Payouts',
    rows: [
      ['GET', '/payouts', 'List payouts.'],
      ['POST', '/payouts', 'Request a settlement. HMAC keys only.'],
    ],
  },
  {
    group: 'Account',
    rows: [
      ['GET', '/account/settings', 'Webhook URL, payout wallets, preferences.'],
      ['PUT', '/account/settings', 'Update settings. Dashboard session only.'],
      ['GET', '/account/api-keys', 'List your API keys.'],
      ['POST', '/account/api-keys', 'Create a key. Secret shown once.'],
      ['GET', '/account/api-keys/primary', 'The key the dashboard displays.'],
      ['POST', '/account/api-keys/regenerate', 'Roll a key. Session only.'],
      ['DELETE', '/account/api-keys/{id}', 'Revoke a key.'],
      ['GET', '/account/analytics', 'Aggregated figures. `?days=` 1–365, default 30.'],
      ['GET', '/account/commission', 'Your current commission agreement.'],
      ['GET', '/account/webhook-logs', 'Delivery attempts, with status codes.'],
      ['GET', '/account/unexpected-deposits', 'Funds sent to a wrong or expired address.'],
      ['POST', '/account/unexpected-deposits/{id}/recover', 'Attempt recovery.'],
      ['POST', '/account/change-password', 'Session only.'],
      ['GET', '/account/onboarding', 'Onboarding checklist state.'],
    ],
  },
  {
    group: 'Public probes (no auth)',
    rows: [
      ['GET', '/networks', 'Which chains this gateway settles right now.'],
      ['GET', '/assets', 'Which (network, asset) pairs are settleable.'],
      ['GET', '/rates', 'Live fiat rates, with source and staleness.'],
      ['GET', '/auth/signup-status', 'Whether self-registration is open.'],
    ],
  },
];

const WEBHOOK_EVENTS: [string, string][] = [
  ['payment.created', 'A deposit address was issued. Nothing has arrived yet.'],
  ['payment.confirming', 'Funds seen on-chain, gathering confirmations.'],
  ['payment.confirmed', 'Irreversible. THIS is when you fulfil the order.'],
  ['payment.expired', 'The payment window closed without full payment.'],
  ['payment.reverted', 'A chain reorg undid a previously seen deposit.'],
  ['payment.swept', 'Funds moved to the collection wallet.'],
  ['payout.completed', 'A settlement to your wallet confirmed on-chain.'],
  ['invoice.paid', 'An invoice was paid in full.'],
];

const STATUSES: [string, string][] = [
  ['waiting', 'Awaiting the customer deposit.'],
  ['confirming', 'Deposit seen on-chain, gathering confirmations.'],
  ['confirmed', 'Reached the required confirmations. Webhook fired.'],
  ['partial', 'Received less than the requested amount.'],
  ['swept', 'Funds moved to the central collection wallet.'],
  ['expired', 'Payment window elapsed without full payment.'],
  ['failed', 'Payment failed or was dropped by a chain reorg.'],
];

const ERRORS: [string, string, string][] = [
  ['400', 'validation_error', 'Malformed body, or a network/asset this gateway does not settle.'],
  ['401', 'unauthorized', 'Missing, unknown or revoked key; bad signature; timestamp outside the 5-minute window.'],
  ['403', 'forbidden', 'Key lacks the required scope, account not approved, or the caller IP is not on your allowlist.'],
  ['404', 'not_found', 'No such resource, or it belongs to another merchant.'],
  ['409', 'conflict', 'Idempotency-Key reused with a different body.'],
  ['429', 'rate_limited', 'Throttled. Back off and retry — see the RateLimit-* headers.'],
  ['500', 'internal_error', 'Our fault. Safe to retry with the same Idempotency-Key.'],
];

const SECTIONS = [
  ['auth', 'Authentication'],
  ['assets', 'Networks & assets'],
  ['create', 'Create a payment'],
  ['fiat', 'Pricing in fiat'],
  ['endpoints', 'Endpoint reference'],
  ['webhooks', 'Webhooks'],
  ['statuses', 'Payment statuses'],
  ['errors', 'Errors & limits'],
] as const;

/** Stable array identity, so the observer below is not torn down every render. */
const SECTION_IDS: string[] = SECTIONS.map(([id]) => id);

const ENDPOINT_COUNT = ENDPOINTS.reduce((n, g) => n + g.rows.length, 0);

/** Two-digit index, tabular, so the numerals line up down the contents column. */
const ord = (i: number) => String(i + 1).padStart(2, '0');

/**
 * Which section the reader is actually looking at.
 *
 * The band is the top third of the viewport rather than the whole of it: with a
 * full-height root, a short section and the long one under it are both
 * "visible" and the rail flickers between them. `-66%` from the bottom means
 * only what is under the reader's eye counts.
 *
 * Guarded on IntersectionObserver, and the rail simply stays unlit without it —
 * the anchors work regardless, so this is an enhancement and never a
 * dependency.
 */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        // Document order, not observation order: entries arrive in whatever
        // order the browser reports them.
        const first = ids.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      { rootMargin: '-80px 0px -66% 0px' },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);

  return active;
}

// ---------------------------------------------------------------------------


export default function ApiDocs() {
  // The asset matrix is READ FROM THE GATEWAY, not hardcoded. A static table
  // silently lies the moment an operator enables or disables a chain.
  const { data: assets, isLoading: assetsLoading } = useQuery({
    queryKey: ['assets'],
    queryFn: getAssets,
    staleTime: 5 * 60_000,
  });

  const byNetwork = (assets ?? []).reduce<Record<string, typeof assets>>(
    (acc, a) => {
      (acc[a.network] ||= []).push(a);
      return acc;
    },
    {},
  );

  const pairCount = assets?.length ?? 0;
  const active = useActiveSection(SECTION_IDS);

  return (
    <>
      <PageHeader
        eyebrow="Developer"
        title="API Documentation"
        description="Everything needed for a working integration, checked against the running gateway."
        meta={
          <>
            {ENDPOINT_COUNT} endpoints · {WEBHOOK_EVENTS.length} webhook events
          </>
        }
      />

      <div className="lg:flex lg:gap-12">
        {/* THE INDEX. Sticky, so the reader never loses their place in a long
            reference — the single biggest usability win on a docs page — and
            numbered, so "how much of this is left" is answerable at a glance.
            The lit rail is brand because an active nav marker is one of the
            four sanctioned uses of the interactive colour; the seven unlit
            rails are the hairline, not a dimmed brand. */}
        <nav
          aria-label="On this page"
          className="hidden shrink-0 lg:sticky lg:top-6 lg:block lg:h-fit lg:w-56"
        >
          <span className="runhead">Contents</span>
          <ol className="mt-3">
            {SECTIONS.map(([id, label], i) => {
              const on = active === id;
              return (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    aria-current={on ? 'true' : undefined}
                    className={`flex items-baseline gap-3 border-l-2 py-1.5 pl-3 text-sm outline-none transition-colors duration-[var(--dur-press)] focus-visible:ring-2 focus-visible:ring-brand-500 ${
                      on
                        ? 'border-brand-600 font-medium text-slate-900 dark:border-brand-400 dark:text-slate-50'
                        : 'border-slate-200 text-slate-600 hover:text-slate-900 dark:border-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
                    }`}
                  >
                    <span className="num shrink-0 text-[10px] tracking-[0.14em] text-slate-400 dark:text-slate-500">
                      {ord(i)}
                    </span>
                    {label}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="min-w-0 flex-1 space-y-12">
          {/* ---------------- AUTH ---------------- */}
          <section id="auth" className="scroll-mt-6">
            <SectionHeading n="01" first>
              Authentication
            </SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Base URL <code className="code">{BASE}</code>. Keys come in two
              modes and the mode is fixed when the key is created — a signed
              request with a bearer key, or an unsigned request with an HMAC key,
              is rejected rather than downgraded.
            </p>

            {/* The two key modes as two ruled columns rather than two cards.
                Icons are slate-400, the documented step for a decorative mark —
                a shield that is not a button has no business wearing brand. */}
            <div className="mt-8 grid gap-x-12 gap-y-10 lg:grid-cols-2">
              <div className="min-w-0">
                <h3 className="rule-b flex items-baseline gap-2.5 pb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <ShieldCheck size={15} className="shrink-0 translate-y-0.5 text-slate-400" aria-hidden />
                  <span>
                    HMAC-signed{' '}
                    <span className="font-mono text-xs font-normal text-slate-500 dark:text-slate-400">
                      pk_live_…
                    </span>
                  </span>
                </h3>
                <dl className="text-sm">
                  <Header name="X-Api-Key">your public key id</Header>
                  <Header name="X-Timestamp">
                    unix <strong>seconds</strong>
                  </Header>
                  <Header name="X-Signature">
                    <code className="code">
                      hex( HMAC_SHA256( secret, "&#123;ts&#125;.&#123;rawBody&#125;" ) )
                    </code>
                  </Header>
                </dl>
                <p className="measure mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Required for <code className="code">POST /payouts</code>. GET
                  requests have an empty raw body, so you sign{' '}
                  <code className="code">"&#123;ts&#125;."</code>. Requests more
                  than 5 minutes from server time are rejected — keep your clock
                  on NTP.
                </p>
              </div>

              <div className="min-w-0">
                <h3 className="rule-b flex items-baseline gap-2.5 pb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <KeyRound size={15} className="shrink-0 translate-y-0.5 text-slate-400" aria-hidden />
                  <span>
                    Bearer{' '}
                    <span className="font-mono text-xs font-normal text-slate-500 dark:text-slate-400">
                      ak_live_…
                    </span>
                  </span>
                </h3>
                <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                  One token in <code className="code">X-Api-Key</code>, nothing
                  to sign. Simpler, and strictly weaker: the credential is on the
                  wire every request.
                </p>
                <div className="mt-4">
                  <CodeBlock
                    tabs={[{ label: 'curl', code: bearerSnippet }]}
                    title="POST /payments"
                  />
                </div>
                <p className="measure mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Bearer keys cannot hold <code className="code">payouts:write</code>,
                  so a leaked one can read data and create payments but cannot
                  move funds. Pair it with an IP allowlist.
                </p>
              </div>
            </div>

            <Callout tone="warn" className="mt-8">
              <strong>If you integrated before August 2026, re-check your
              signing.</strong> An earlier version of this page documented{' '}
              <code className="code">timestamp + body</code> with a{' '}
              <em>millisecond</em> timestamp. The gateway has always expected{' '}
              <code className="code">timestamp + "." + body</code> with{' '}
              <em>seconds</em>. Code built from the old snippet returns 401 on
              every request.
            </Callout>

            <p className="measure-wide mt-6 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              No API key of either mode can change your payout wallet, your
              password or your set of keys — those need a signed-in dashboard
              session. That is what stops a stolen key from redirecting your
              money.
            </p>
          </section>

          {/* ---------------- ASSETS ---------------- */}
          <section id="assets" className="scroll-mt-6">
            <SectionHeading n="02">Networks &amp; assets</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              A payment is a <strong>(network, asset)</strong> pair, fixed at
              creation. Omit <code className="code">network</code> for BEP20 and{' '}
              <code className="code">asset</code> for USDT, so existing
              integrations keep working. The table below is read live from this
              gateway — it is what you can actually charge today.
            </p>

            {assetsLoading ? (
              // `.ghost`, not `.skeleton`: static by design. See the motion note
              // at the top of this file.
              <div className="mt-8 grid gap-x-12 gap-y-8 sm:grid-cols-2">
                {[0, 1].map((i) => (
                  <div key={i}>
                    <div className="ghost h-4 w-20" />
                    <div className="ghost mt-4 h-3 w-full" />
                    <div className="ghost mt-3 h-3 w-4/5" />
                    <div className="ghost mt-3 h-3 w-3/5" />
                  </div>
                ))}
              </div>
            ) : Object.keys(byNetwork).length === 0 ? (
              <p className="measure mt-6 text-sm text-slate-500 dark:text-slate-400">
                Could not read the asset catalogue from the gateway.
              </p>
            ) : (
              <div className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-12">
                {/* THE FIGURE. The live pair count, and deliberately absent
                    until /assets answers — a placeholder zero on a page about
                    what you can charge is a claim, and the wrong one. */}
                <div className="md:col-span-3">
                  <span className="runhead">Settleable now</span>
                  <span className="figure-lg mt-2">{pairCount}</span>
                  <span className="figure-label measure">
                    (network, asset) pairs, read from{' '}
                    <code className="code">/assets</code> on this gateway rather
                    than written into this page.
                  </span>
                </div>

                <div className="grid gap-x-12 gap-y-8 sm:grid-cols-2 md:col-span-9">
                  {Object.entries(byNetwork).map(([network, list]) => (
                    <div key={network} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <h3 className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {network}
                        </h3>
                        <span className="num text-xs text-slate-500 dark:text-slate-400">
                          {list?.length} asset{list?.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <ul className="mt-2 border-b border-slate-200 dark:border-slate-800">
                        {list?.map((a) => (
                          <li
                            key={a.symbol}
                            className="rule flex items-baseline justify-between gap-3 py-2"
                          >
                            <span className="font-mono text-xs text-slate-800 dark:text-slate-200">
                              {a.symbol}
                              {a.isNative && (
                                <span className="ml-1.5 text-[10px] uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">
                                  native
                                </span>
                              )}
                            </span>
                            <span className="truncate text-xs text-slate-500 dark:text-slate-400">
                              {a.name}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Callout tone="danger" className="mt-8">
              A deposit address is valid <strong>only</strong> for the network it
              was issued on. Sending TRC20 funds to a BEP20 address — or any
              other cross-network mix-up — is unrecoverable. Never reuse an
              address across chains, and never assume decimals from the chain:
              USDT is 18 dp on BEP20 and 6 dp on ERC20 and TRC20. Send{' '}
              <code className="code">amount</code> as a human string like{' '}
              <code className="code">"50.00"</code> and let the gateway scale it.
            </Callout>
          </section>

          {/* ---------------- CREATE ---------------- */}
          <section id="create" className="scroll-mt-6">
            <SectionHeading n="03">Create a payment</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <code className="code">POST /payments</code> returns a fresh
              deposit address and QR for the chosen pair. Always send an{' '}
              <code className="code">Idempotency-Key</code> — retrying without
              one creates a second payment and a second address for the same
              order.
            </p>

            <Specimen runhead="Request · four languages, one signature">
              <CodeBlock tabs={createPaymentTabs} title="POST /payments" />
            </Specimen>

            <Specimen runhead="Response · 201 Created">
              <CodeBlock
                tabs={[
                  { label: 'Crypto-priced', code: responseCrypto },
                  { label: 'Fiat-priced', code: responseFiat },
                ]}
              />
            </Specimen>
          </section>

          {/* ---------------- FIAT ---------------- */}
          <section id="fiat" className="scroll-mt-6">
            <SectionHeading n="04">Pricing in fiat</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Send <code className="code">fiatAmount</code> and{' '}
              <code className="code">fiatCurrency</code> <em>instead of</em>{' '}
              <code className="code">amount</code> — supplying both, or neither,
              is rejected. The gateway converts at the market rate, locks it on
              the payment, and never revisits it, so the figure you quoted is the
              figure you reconcile.
            </p>

            <Specimen runhead="Request body">
              <CodeBlock tabs={[{ label: 'Request body', code: fiatRequest }]} />
            </Specimen>

            <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              <code className="code">GET /rates</code> lists the currencies this
              gateway can price in, plus the rate source and its age in seconds.
              Check the age before showing a converted price — a stale quote is
              still a quote, and the caller is entitled to know.
            </p>
          </section>

          {/* ---------------- ENDPOINTS ---------------- */}
          <section id="endpoints" className="scroll-mt-6">
            <SectionHeading n="05">Endpoint reference</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Every endpoint a merchant can reach. List endpoints accept{' '}
              <code className="code">?page</code> and{' '}
              <code className="code">?limit</code> and return{' '}
              <code className="code">&#123; data, page, total &#125;</code>.
            </p>

            {/* Seven ledgers rather than seven cards. The group name is the
                running head and it sits over the ink rule the ledger's own
                header would otherwise draw, so the column headers are not
                repeated seven times down the page. */}
            <div className="mt-8 space-y-8">
              {ENDPOINTS.map((g) => (
                <div key={g.group}>
                  <div className="flex items-baseline justify-between gap-4 border-b border-slate-900 pb-1.5 dark:border-slate-100">
                    <h3 className="runhead text-slate-900 dark:text-slate-100">
                      {g.group}
                    </h3>
                    <span className="num text-xs text-slate-500 dark:text-slate-400">
                      {g.rows.length}
                    </span>
                  </div>
                  <div className="ledger-scroll">
                    <table className="ledger">
                      <caption className="sr-only">{g.group} endpoints</caption>
                      <tbody>
                        {g.rows.map(([method, path, desc]) => (
                          <tr key={method + path}>
                            <td className="w-0 whitespace-nowrap py-2.5 align-top">
                              <MethodBadge method={method} />
                            </td>
                            <td className="whitespace-nowrap py-2.5 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                              {path}
                            </td>
                            <td className="py-2.5 align-top text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                              {desc}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ---------------- WEBHOOKS ---------------- */}
          <section id="webhooks" className="scroll-mt-6">
            <SectionHeading n="06">Webhooks</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              We POST to your configured URL as a payment moves. The hex
              signature arrives twice — in the{' '}
              <code className="code">signature</code> field of the body and in
              the <code className="code">X-Gateway-Signature</code> header — and
              the event name is also in{' '}
              <code className="code">X-Gateway-Event</code>.
            </p>

            <Callout tone="warn" className="mt-6">
              <strong>The signature does not cover the raw bytes.</strong> It is
              computed over the body with{' '}
              <code className="code">signature</code> set to{' '}
              <code className="code">""</code>. To verify: parse, blank the
              field, re-serialize compactly preserving key order, HMAC that, and
              compare in constant time. Hashing the raw body will never match.
            </Callout>

            <Specimen runhead="Verifying a delivery">
              <CodeBlock tabs={webhookVerifyTabs} title="your endpoint" />
            </Specimen>

            <div className="ledger-scroll mt-8">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {WEBHOOK_EVENTS.map(([name, desc]) => (
                    <tr key={name}>
                      <td className="whitespace-nowrap py-2.5 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                        {name}
                      </td>
                      <td className="py-2.5 align-top text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                        {desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Deliveries retry with exponential backoff until they get a 2xx.
              Return 2xx immediately and do the work asynchronously; every
              attempt, status code and response body is recorded under{' '}
              <strong>Webhook logs</strong>. Fulfil idempotently — the same event
              can arrive more than once.
            </p>
          </section>

          {/* ---------------- STATUSES ---------------- */}
          <section id="statuses" className="scroll-mt-6">
            <SectionHeading n="07">Payment statuses</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Fulfil on <code className="code">confirmed</code>, never earlier.
              Everything before it can still change.
            </p>
            <div className="ledger-scroll mt-6">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {STATUSES.map(([status, desc]) => (
                    <tr key={status}>
                      <td className="whitespace-nowrap py-2.5 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                        {status}
                      </td>
                      <td className="py-2.5 align-top text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                        {desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ---------------- ERRORS ---------------- */}
          <section id="errors" className="scroll-mt-6">
            <SectionHeading n="08">Errors &amp; limits</SectionHeading>
            <p className="measure-wide mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Every failure returns{' '}
              <code className="code">
                &#123; "error": "code", "message": "…" &#125;
              </code>{' '}
              with a matching HTTP status. Branch on{' '}
              <code className="code">error</code>, not on the message text.
            </p>
            <div className="ledger-scroll mt-6">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      HTTP
                    </th>
                    <th scope="col">Code</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {ERRORS.map(([status, code, desc]) => (
                    <tr key={code}>
                      <td className="num w-0 whitespace-nowrap py-2.5 align-top font-mono text-xs text-slate-500 dark:text-slate-400">
                        {status}
                      </td>
                      <td className="whitespace-nowrap py-2.5 align-top font-mono text-xs text-slate-900 dark:text-slate-100">
                        {code}
                      </td>
                      <td className="py-2.5 align-top text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                        {desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="measure-wide mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Authenticated calls are throttled per API key (120 requests per
              minute by default) and responses carry the standard{' '}
              <code className="code">RateLimit-*</code> headers. On a{' '}
              <code className="code">429</code> or{' '}
              <code className="code">500</code>, retry with the{' '}
              <em>same</em> <code className="code">Idempotency-Key</code> — the
              gateway replays the original response instead of creating a second
              payment.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/**
 * A section opener: the numeral as a running head, the title under it, and a
 * hairline above the whole block.
 *
 * `first` drops the hairline on section 01, which otherwise sits a few
 * millimetres under PageHeader's heavy masthead rule and reads as a stutter.
 * That masthead stroke is the only strong rule the page gets.
 */
function SectionHeading({
  n,
  first = false,
  children,
}: {
  n: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={first ? '' : 'rule pt-8'}>
      <span className="runhead num">{n}</span>
      <h2 className="mt-1.5 text-xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
        {children}
      </h2>
    </div>
  );
}

/**
 * A code specimen with a running head naming what it is. The block itself is
 * CodeBlock — dark chrome, language tabs, one copy control — and this only
 * gives it a caption, because an unlabelled snippet in a long reference is a
 * puzzle.
 */
function Specimen({ runhead, children }: { runhead: string; children: ReactNode }) {
  return (
    <div className="mt-6">
      <span className="runhead mb-2">{runhead}</span>
      {children}
    </div>
  );
}

/** One request header, as a ruled label/value row. */
function Header({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="rule flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
      <dt className="w-[7.25rem] shrink-0">
        <code className="code">{name}</code>
      </dt>
      <dd className="min-w-0 flex-1 text-slate-600 dark:text-slate-300">{children}</dd>
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  // Method colour is structural, not semantic-financial: it says "this reads"
  // vs "this writes". Green stays out of it — on this product green means money
  // arrived, and a GET badge is not a settled payment. Brand is out of it too,
  // now: an indigo fill on a label nobody can click spends the interactive
  // colour on decoration. The word is the carrier, weight is the emphasis, and
  // the mark survives in greyscale.
  const tone =
    method === 'GET'
      ? 'text-slate-500 dark:text-slate-400'
      : method === 'DELETE'
        ? 'text-red-600 dark:text-red-400'
        : 'text-slate-900 dark:text-slate-100';
  return (
    <span className={`font-mono text-[10px] font-semibold uppercase tracking-[0.12em] ${tone}`}>
      {method}
    </span>
  );
}

/**
 * A ruled note, not a tinted box.
 *
 * The hue still means what it means everywhere else in the product — amber is
 * "wait, there is something you have to do", red is "you can lose money here" —
 * but it is spent on a 2px rule and a label rather than on a fill, and the
 * label is a WORD, so the distinction survives in greyscale and for a
 * red/green-blind reader. The body stays in ink on a measure, because it is the
 * part that has to be read.
 */
function Callout({
  tone,
  className = '',
  children,
}: {
  tone: 'warn' | 'danger';
  className?: string;
  children: ReactNode;
}) {
  const danger = tone === 'danger';
  const stroke = danger
    ? 'border-red-600 dark:border-red-400'
    : 'border-amber-600 dark:border-amber-400';
  const ink = danger
    ? 'text-red-600 dark:text-red-400'
    : 'text-amber-600 dark:text-amber-400';
  return (
    <div className={`border-t-2 pt-3 ${stroke} ${className}`}>
      <p className={`runhead flex items-center gap-2 ${ink}`}>
        <AlertTriangle size={13} className="shrink-0" aria-hidden />
        {danger ? 'Unrecoverable' : 'Important'}
      </p>
      <div className="measure-wide mt-2 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </div>
    </div>
  );
}
