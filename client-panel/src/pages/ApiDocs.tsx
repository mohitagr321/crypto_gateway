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

  return (
    <>
      <PageHeader
        title="API Documentation"
        description="Everything needed for a working integration, checked against the running gateway."
      />

      <div className="lg:flex lg:gap-10">
        {/* On-page nav. Sticky so the reader never loses their place in a long
            reference — the single biggest usability win on a docs page. */}
        <nav
          aria-label="On this page"
          className="mb-8 hidden shrink-0 lg:sticky lg:top-6 lg:mb-0 lg:block lg:h-fit lg:w-52"
        >
          <p className="section-label mb-3">On this page</p>
          <ul className="space-y-1">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="block rounded-lg px-3 py-1.5 text-sm text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 space-y-10">
          {/* ---------------- AUTH ---------------- */}
          <section id="auth" className="scroll-mt-6">
            <SectionHeading>Authentication</SectionHeading>
            <p className="mb-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Base URL <code className="code">{BASE}</code>. Keys come in two
              modes and the mode is fixed when the key is created — a signed
              request with a bearer key, or an unsigned request with an HMAC key,
              is rejected rather than downgraded.
            </p>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="card p-6">
                <div className="mb-3 flex items-center gap-2.5">
                  <ShieldCheck size={17} className="text-brand-600 dark:text-brand-400" />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    HMAC-signed <span className="font-mono text-xs font-normal text-slate-500">pk_live_…</span>
                  </h3>
                </div>
                <dl className="space-y-2 text-sm">
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
                <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Required for <code className="code">POST /payouts</code>. GET
                  requests have an empty raw body, so you sign{' '}
                  <code className="code">"&#123;ts&#125;."</code>. Requests more
                  than 5 minutes from server time are rejected — keep your clock
                  on NTP.
                </p>
              </div>

              <div className="card p-6">
                <div className="mb-3 flex items-center gap-2.5">
                  <KeyRound size={17} className="text-slate-500" />
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Bearer <span className="font-mono text-xs font-normal text-slate-500">ak_live_…</span>
                  </h3>
                </div>
                <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                  One token in <code className="code">X-Api-Key</code>, nothing
                  to sign. Simpler, and strictly weaker: the credential is on the
                  wire every request.
                </p>
                <div className="mt-4">
                  <CodeBlock tabs={[{ label: 'curl', code: bearerSnippet }]} />
                </div>
                <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                  Bearer keys cannot hold <code className="code">payouts:write</code>,
                  so a leaked one can read data and create payments but cannot
                  move funds. Pair it with an IP allowlist.
                </p>
              </div>
            </div>

            <Callout tone="warn" className="mt-5">
              <strong>If you integrated before August 2026, re-check your
              signing.</strong> An earlier version of this page documented{' '}
              <code className="code">timestamp + body</code> with a{' '}
              <em>millisecond</em> timestamp. The gateway has always expected{' '}
              <code className="code">timestamp + "." + body</code> with{' '}
              <em>seconds</em>. Code built from the old snippet returns 401 on
              every request.
            </Callout>

            <p className="mt-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              No API key of either mode can change your payout wallet, your
              password or your set of keys — those need a signed-in dashboard
              session. That is what stops a stolen key from redirecting your
              money.
            </p>
          </section>

          {/* ---------------- ASSETS ---------------- */}
          <section id="assets" className="scroll-mt-6">
            <SectionHeading>Networks &amp; assets</SectionHeading>
            <p className="mb-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              A payment is a <strong>(network, asset)</strong> pair, fixed at
              creation. Omit <code className="code">network</code> for BEP20 and{' '}
              <code className="code">asset</code> for USDT, so existing
              integrations keep working. The table below is read live from this
              gateway — it is what you can actually charge today.
            </p>

            {assetsLoading ? (
              <div className="skeleton h-32 w-full" />
            ) : Object.keys(byNetwork).length === 0 ? (
              <p className="text-sm text-slate-500">
                Could not read the asset catalogue from the gateway.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {Object.entries(byNetwork).map(([network, list]) => (
                  <div key={network} className="card p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="font-mono text-sm font-semibold text-brand-700 dark:text-brand-300">
                        {network}
                      </h3>
                      <span className="text-xs text-slate-400">
                        {list?.length} asset{list?.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {list?.map((a) => (
                        <li
                          key={a.symbol}
                          className="flex items-baseline justify-between gap-3 text-sm"
                        >
                          <span className="font-mono text-xs text-slate-700 dark:text-slate-200">
                            {a.symbol}
                            {a.isNative && (
                              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">
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
            )}

            <Callout tone="danger" className="mt-5">
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
            <SectionHeading>Create a payment</SectionHeading>
            <p className="mb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <code className="code">POST /payments</code> returns a fresh
              deposit address and QR for the chosen pair. Always send an{' '}
              <code className="code">Idempotency-Key</code> — retrying without
              one creates a second payment and a second address for the same
              order.
            </p>
            <CodeBlock tabs={createPaymentTabs} />

            <h3 className="mb-2 mt-6 text-sm font-semibold text-slate-700 dark:text-slate-200">
              Response{' '}
              <span className="font-normal text-slate-400">201 Created</span>
            </h3>
            <CodeBlock
              tabs={[
                { label: 'Crypto-priced', code: responseCrypto },
                { label: 'Fiat-priced', code: responseFiat },
              ]}
            />
          </section>

          {/* ---------------- FIAT ---------------- */}
          <section id="fiat" className="scroll-mt-6">
            <SectionHeading>Pricing in fiat</SectionHeading>
            <p className="mb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Send <code className="code">fiatAmount</code> and{' '}
              <code className="code">fiatCurrency</code> <em>instead of</em>{' '}
              <code className="code">amount</code> — supplying both, or neither,
              is rejected. The gateway converts at the market rate, locks it on
              the payment, and never revisits it, so the figure you quoted is the
              figure you reconcile.
            </p>
            <CodeBlock tabs={[{ label: 'Request body', code: fiatRequest }]} />
            <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              <code className="code">GET /rates</code> lists the currencies this
              gateway can price in, plus the rate source and its age in seconds.
              Check the age before showing a converted price — a stale quote is
              still a quote, and the caller is entitled to know.
            </p>
          </section>

          {/* ---------------- ENDPOINTS ---------------- */}
          <section id="endpoints" className="scroll-mt-6">
            <SectionHeading>Endpoint reference</SectionHeading>
            <p className="mb-5 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Every endpoint a merchant can reach. List endpoints accept{' '}
              <code className="code">?page</code> and{' '}
              <code className="code">?limit</code> and return{' '}
              <code className="code">&#123; data, page, total &#125;</code>.
            </p>
            <div className="space-y-5">
              {ENDPOINTS.map((g) => (
                <div key={g.group} className="card overflow-hidden">
                  <p className="border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-400">
                    {g.group}
                  </p>
                  <table className="w-full text-sm">
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {g.rows.map(([method, path, desc]) => (
                        <tr key={method + path}>
                          <td className="whitespace-nowrap py-2.5 pl-5 pr-3 align-top">
                            <MethodBadge method={method} />
                          </td>
                          <td className="whitespace-nowrap py-2.5 pr-4 align-top font-mono text-xs text-slate-800 dark:text-slate-200">
                            {path}
                          </td>
                          <td className="py-2.5 pr-5 align-top text-xs text-slate-600 dark:text-slate-400">
                            {desc}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>

          {/* ---------------- WEBHOOKS ---------------- */}
          <section id="webhooks" className="scroll-mt-6">
            <SectionHeading>Webhooks</SectionHeading>
            <p className="mb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              We POST to your configured URL as a payment moves. The hex
              signature arrives twice — in the{' '}
              <code className="code">signature</code> field of the body and in
              the <code className="code">X-Gateway-Signature</code> header — and
              the event name is also in{' '}
              <code className="code">X-Gateway-Event</code>.
            </p>

            <Callout tone="warn" className="mb-5">
              <strong>The signature does not cover the raw bytes.</strong> It is
              computed over the body with{' '}
              <code className="code">signature</code> set to{' '}
              <code className="code">""</code>. To verify: parse, blank the
              field, re-serialize compactly preserving key order, HMAC that, and
              compare in constant time. Hashing the raw body will never match.
            </Callout>

            <CodeBlock tabs={webhookVerifyTabs} />

            <h3 className="mb-3 mt-6 text-sm font-semibold text-slate-700 dark:text-slate-200">
              Events
            </h3>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {WEBHOOK_EVENTS.map(([name, desc]) => (
                    <tr key={name}>
                      <td className="whitespace-nowrap py-2.5 pl-5 pr-4 align-top font-mono text-xs text-brand-700 dark:text-brand-300">
                        {name}
                      </td>
                      <td className="py-2.5 pr-5 text-xs text-slate-600 dark:text-slate-400">
                        {desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Deliveries retry with exponential backoff until they get a 2xx.
              Return 2xx immediately and do the work asynchronously; every
              attempt, status code and response body is recorded under{' '}
              <strong>Webhook logs</strong>. Fulfil idempotently — the same event
              can arrive more than once.
            </p>
          </section>

          {/* ---------------- STATUSES ---------------- */}
          <section id="statuses" className="scroll-mt-6">
            <SectionHeading>Payment statuses</SectionHeading>
            <p className="mb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Fulfil on <code className="code">confirmed</code>, never earlier.
              Everything before it can still change.
            </p>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {STATUSES.map(([status, desc]) => (
                    <tr key={status}>
                      <td className="whitespace-nowrap py-2.5 pl-5 pr-4 align-top font-mono text-xs text-brand-700 dark:text-brand-300">
                        {status}
                      </td>
                      <td className="py-2.5 pr-5 text-xs text-slate-600 dark:text-slate-400">
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
            <SectionHeading>Errors &amp; limits</SectionHeading>
            <p className="mb-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Every failure returns{' '}
              <code className="code">
                &#123; "error": "code", "message": "…" &#125;
              </code>{' '}
              with a matching HTTP status. Branch on{' '}
              <code className="code">error</code>, not on the message text.
            </p>
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {ERRORS.map(([status, code, desc]) => (
                    <tr key={code}>
                      <td className="whitespace-nowrap py-2.5 pl-5 pr-3 align-top font-mono text-xs text-slate-500">
                        {status}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 align-top font-mono text-xs text-slate-800 dark:text-slate-200">
                        {code}
                      </td>
                      <td className="py-2.5 pr-5 text-xs text-slate-600 dark:text-slate-400">
                        {desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-50">
      {children}
    </h2>
  );
}

function Header({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <dt>
        <code className="code">{name}</code>
      </dt>
      <dd className="text-slate-600 dark:text-slate-300">{children}</dd>
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  // Method colour is structural, not semantic-financial: it says "this reads"
  // vs "this writes". Green stays out of it — on this product green means money
  // arrived, and a GET badge is not a settled payment.
  const tone =
    method === 'GET'
      ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
      : method === 'DELETE'
        ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
        : 'bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${tone}`}
    >
      {method}
    </span>
  );
}

function Callout({
  tone,
  className = '',
  children,
}: {
  tone: 'warn' | 'danger';
  className?: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === 'danger'
      ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200';
  return (
    <div
      className={`flex gap-3 rounded-xl border p-4 text-xs leading-relaxed ${styles} ${className}`}
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
