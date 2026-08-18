import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ChevronDown,
  KeyRound,
  ShieldCheck,
} from 'lucide-react';
import { API_BASE_URL, getAssets } from '@/lib/api';
import type { AssetInfo } from '@/types';
import PageHeader from '@/components/PageHeader';
import CodeBlock from '@/components/CodeBlock';
import type { CodeTab } from '@/components/CodeBlock';

/**
 * The authenticated API reference.
 *
 * Two things in here were previously WRONG in a way that guaranteed a failed
 * integration, and both are called out at the point of use rather than fixed
 * silently, because merchants have copied the old versions:
 *
 *   1. Request signing. This page used to sign `timestamp + body` with a
 *      MILLISECOND timestamp. The timestamp is unix SECONDS
 *      (backend/src/middleware/auth.ts) — so every request built from the old
 *      snippets returned 401.
 *
 *      The signed STRING has since changed too: it is now
 *      `${ts}.${METHOD}.${path}.${sha256(rawBody)}` (v2), because the old
 *      `${ts}.${rawBody}` bound neither the verb nor the path, so a signature
 *      captured from a status poll was a valid signature for POST /payouts
 *      inside the 5-minute window. Keys still accept the legacy form until an
 *      operator sets api_keys.signature_version = 2, so the snippets here teach
 *      v2 while the prose names v1 as legacy rather than deleting it — a
 *      merchant reading this page has the old form in their code.
 *   2. Webhook verification. This page used to HMAC the raw request body. The
 *      signature is computed over the body with the `signature` field blanked
 *      (backend/src/services/webhookService.ts), so hashing the raw bytes never
 *      matched.
 *
 * Anything added here must be checked against the route it documents. A docs
 * page that is confidently wrong costs more than no docs page.
 *
 * ---------------------------------------------------------------------------
 * SET AS A REFERENCE WORK, ON SURFACES. The prose is unchanged; the STRUCTURE
 * around it is what this pass rebuilt. The page is dense reference material a
 * developer reads with their editor open beside it, so every decision below
 * resolves in favour of reading over decoration:
 *
 *   - EIGHT CHAPTERS, EIGHT SURFACES. The outgoing version set them as a single
 *     column of hairline-opened bands, which gave the eye nothing to land on:
 *     every heading had exactly the status of every other. A raised block per
 *     chapter, separated by ground rather than by a rule, is what lets somebody
 *     scanning for "Webhooks" find it without reading. Rules survive INSIDE a
 *     chapter, which is the job they are actually good at.
 *   - THE INDEX IS NAVIGATION, so it sits on a surface and wears `.nav-item` /
 *     `.nav-item-on` — the product's own rail classes. Brand marks the one
 *     entry you can see rather than decorating all eight. Below `lg` it
 *     collapses into a native `<details>`, because 14rem of permanent furniture
 *     in front of the document is not a reasonable trade on a 360px screen.
 *   - CODE SITS IN A `.well`, the inset surface. A sample is a window cut into
 *     the chapter, not an object resting on it.
 *   - THE FOUR REFERENCE TABLES ARE NO LONGER TABLES. A table cannot restack,
 *     so at 360px the verb, the path and the sentence explaining it fought over
 *     one line and the reader dragged the page sideways to read a reference.
 *     They are grid rows that reflow instead. Nothing on this page scrolls
 *     horizontally except code, where horizontal is the honest shape.
 *   - CALLOUTS keep their word AND their hue. Amber and red mean here what they
 *     mean everywhere else in the product, and the label carries the meaning on
 *     its own, so it survives in greyscale.
 *
 * MOTION: none on mount. The two moving parts are the position rail, driven by
 * an IntersectionObserver and changing a colour, and the disclosure chevron on
 * the phone index — both 120ms, both responses to something the reader did.
 * The loading placeholder is `.ghost`, which is static by design: this is a
 * dashboard route and a shimmer loop is banned on one.
 */

const BASE = API_BASE_URL;
/**
 * The path portion of BASE (normally "/api/v1").
 *
 * Load-bearing in every signing snippet below: the v2 signed string covers the
 * request target the SERVER sees, which includes this prefix. Signing
 * "/payments" when the wire path is "/api/v1/payments" is a 401 with no clue
 * as to why, so the snippets derive it rather than hardcoding a guess.
 */
const PATH_PREFIX = new URL(BASE, window.location.origin).pathname.replace(/\/+$/, '');

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

interface SpecimenProps {
  /** The caption over the block. Every specimen gets one: an unlabelled snippet
   *  in a 1,400-line reference is a puzzle. */
  runhead: string;
  tabs: CodeTab[];
  /** The route the sample calls, printed small in the block's own chrome. */
  title?: string;
}

const createPaymentTabs: CodeTab[] = [
  {
    label: 'curl',
    code: `# v2 signed string: "<ts>.<METHOD>.<path>.<sha256(body)>".
# The timestamp is unix SECONDS, not milliseconds, and <path> is the request
# target as the server sees it — prefix included, query string included.
API_KEY="pk_live_your_key"
API_SECRET="your_api_secret"
TS=$(date +%s)
BODY='{"amount":"50.00","orderId":"order_789","network":"BEP20","asset":"USDT"}'
BODY_HASH=$(printf "%s" "$BODY" | openssl dgst -sha256 | awk '{print $2}')
SIGNED="$TS.POST.${PATH_PREFIX}/payments.$BODY_HASH"
SIG=$(printf "%s" "$SIGNED" | openssl dgst -sha256 -hmac "$API_SECRET" | awk '{print $2}')

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

  // v2: timestamp.METHOD.path.sha256(body) — the verb and path are signed, so
  // a signature captured from a status poll is not a signature for a payout.
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const signature = crypto
    .createHmac('sha256', process.env.API_SECRET)
    .update(\`\${timestamp}.POST.${PATH_PREFIX}/payments.\${bodyHash}\`)
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

    # v2: timestamp.METHOD.path.sha256(body)
    body_hash = hashlib.sha256(body.encode()).hexdigest()
    signed = f"{timestamp}.POST.${PATH_PREFIX}/payments.{body_hash}"
    signature = hmac.new(
        API_SECRET.encode(), signed.encode(), hashlib.sha256
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

// v2: timestamp.METHOD.path.sha256(body)
$bodyHash = hash("sha256", $body);
$signed = "$timestamp.POST.${PATH_PREFIX}/payments.$bodyHash";
$signature = hash_hmac("sha256", $signed, $apiSecret);

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

const webhookVerifyTabs: CodeTab[] = [
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
  ['409', 'conflict', 'A request with this Idempotency-Key is still in flight. Retry after a moment.'],
  ['422', 'idempotency_key_reuse', 'Idempotency-Key reused with a different body. Use a fresh key per request.'],
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

type SectionId = (typeof SECTIONS)[number][0];

/** Stable array identity, so the observer below is not torn down every render. */
const SECTION_IDS: string[] = SECTIONS.map(([id]) => id);

const ENDPOINT_COUNT = ENDPOINTS.reduce((n, g) => n + g.rows.length, 0);

/** Two-digit index, tabular, so the numerals line up down the contents column. */
const ord = (i: number) => String(i + 1).padStart(2, '0');

/**
 * Numeral and title per chapter, derived from the SAME array the index is built
 * from. They used to be typed twice — once in the contents column, once as a
 * literal `n="03"` on the heading — and a reference work whose index disagrees
 * with its body is worse than one with no index at all.
 *
 * The cast is what `Object.fromEntries` costs: it types its result as an open
 * string map, and this one has exactly the eight keys of `SectionId`.
 */
const CHAPTER = Object.fromEntries(
  SECTIONS.map(([id, label], i) => [id, { n: ord(i), label }]),
) as Record<SectionId, { n: string; label: string }>;

/**
 * Grid templates for the two three-field reference lists, written out as whole
 * class strings rather than composed at runtime. Tailwind scans this file as
 * TEXT: a class assembled from fragments never appears in the stylesheet, and
 * the failure is silent — the row simply falls back to its base layout at every
 * width, which looks like a design choice rather than a missing rule.
 *
 * THREE STEPS, AND THE MIDDLE ONE GOES BACKWARDS. That is not a mistake. What
 * decides whether a description fits beside a path is not the viewport, it is
 * the column the chapter is in — and at exactly `lg` the sticky index appears
 * and takes 244px of it WITHOUT the page getting any wider. Measured at 1024:
 * the body column is 460px, of which the verb and the path want 404, leaving
 * the sentence six pixels and pushing the row out of its surface.
 *
 * So the three-across layout is on from `md` (768, no index yet, ~690px of
 * body), OFF again at `lg` where the index has just eaten the difference, and
 * back on at `xl` where there is genuinely room for both.
 */
const ROUTE_COLS =
  'md:grid-cols-[3.25rem_minmax(0,20rem)_minmax(0,1fr)] lg:grid-cols-[3.25rem_minmax(0,1fr)] xl:grid-cols-[3.25rem_minmax(0,20rem)_minmax(0,1fr)]';
const ERROR_COLS =
  'md:grid-cols-[3.25rem_minmax(0,11rem)_minmax(0,1fr)] lg:grid-cols-[3.25rem_minmax(0,1fr)] xl:grid-cols-[3.25rem_minmax(0,11rem)_minmax(0,1fr)]';

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

  const byNetwork = (assets ?? []).reduce<Record<string, AssetInfo[]>>((acc, a) => {
    (acc[a.network] ||= []).push(a);
    return acc;
  }, {});

  const pairCount = assets?.length ?? 0;
  const active = useActiveSection(SECTION_IDS);

  /**
   * The phone index closes itself once it has done its job. A disclosure that
   * stays open after the reader has jumped leaves a 400px menu sitting between
   * them and the paragraph they just asked for.
   *
   * Driven through a ref rather than by holding `open` in state: `<details>`
   * toggles itself natively, and taking that over would mean re-implementing
   * the keyboard and pointer behaviour the element already has.
   */
  const tocRef = useRef<HTMLDetailsElement>(null);
  const closeToc = () => {
    if (tocRef.current) tocRef.current.open = false;
  };

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

      {/* ================================================================
          THE READING FRAME.
          A fixed 14rem index beside a `minmax(0,1fr)` body, and the zero
          minimum is doing real work: a grid track defaults to `min-content`,
          so without it a single unbreakable path or hash in the body sets the
          column's floor and pushes the whole page sideways.

          `items-start` is what makes the index sticky at all. A grid item
          stretches to the row height by default, which leaves a `position:
          sticky` element nothing to travel inside — it pins to a box it
          already fills and never moves. Start-aligning it keeps the grid AREA
          full height while the nav box itself stays short.
          ================================================================ */}
      <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-5">
        {/* ---- THE INDEX ON A PHONE ----------------------------------
            The desktop rail is 14rem of permanent furniture; on a 360px
            screen that is a screenful of links in front of the document.
            So below `lg` the same index collapses into a disclosure that
            costs one row and opens on a tap.

            A `<details>` rather than a state-driven panel: it needs no
            JavaScript to work, it is a native disclosure to a screen reader,
            and the browser's own find-in-page can open it. ---- */}
        <details
          ref={tocRef}
          className="group surface mb-4 overflow-hidden lg:hidden"
        >
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
            <span className="runhead">On this page</span>
            <span className="num ml-auto text-xs text-slate-500 dark:text-slate-400">
              {SECTIONS.length} sections
            </span>
            <ChevronDown
              size={16}
              aria-hidden
              className="shrink-0 text-slate-400 transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] group-open:rotate-180"
            />
          </summary>
          <nav
            aria-label="On this page"
            className="border-t border-[var(--line-soft)] p-2"
          >
            <TocList active={active} onNavigate={closeToc} />
          </nav>
        </details>

        {/* ---- THE INDEX ON A DESKTOP --------------------------------
            Sticky, so the reader never loses their place in a long reference —
            the single biggest usability win on a docs page — and numbered, so
            "how much of this is left" is answerable at a glance.

            It sits on a surface rather than on the bare canvas because it is
            navigation, and a control floating loose on the ground reads as
            unfinished. The lit entry is `.nav-item-on`, the same marker the
            product's own rail uses: brand ink on the thing you are looking at
            is one of the four sanctioned uses of the interactive colour. ---- */}
        <nav
          aria-label="On this page"
          className="hidden lg:sticky lg:top-2 lg:block lg:self-start"
        >
          <div className="surface p-2">
            <span className="runhead px-2.5 pb-1.5 pt-1">Contents</span>
            <TocList active={active} />
          </div>
        </nav>

        {/* ================================================================
            THE DOCUMENT. Eight chapters, each on its own surface, separated by
            ground rather than by a rule. The outgoing version set them as
            hairline-opened bands in one continuous column, which gave the eye
            no target: every heading had exactly the status of every other and
            the page read as one 4,000-word run. A raised block per chapter is
            what lets somebody scanning for "Webhooks" find it without reading.
            ================================================================ */}
        <div className="min-w-0 space-y-4">
          {/* ---------------- AUTH ---------------- */}
          <Chapter id="auth">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Base URL <code className="code break-all">{BASE}</code>. Keys come
              in two modes and the mode is fixed when the key is created — a
              signed request with a bearer key, or an unsigned request with an
              HMAC key, is rejected rather than downgraded.
            </p>

            {/* The two key modes side by side, divided by a hairline INSIDE the
                chapter. This is what a rule is for now: dividing within a
                surface, rather than standing in for one. Icons are slate-400,
                the documented step for a decorative mark — a shield that is not
                a button has no business wearing brand. */}
            <div className="mt-6 grid gap-6 xl:grid-cols-2 xl:gap-0">
              <div className="min-w-0 xl:pr-8">
                <h3 className="rule-b flex items-baseline gap-2.5 pb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <ShieldCheck
                    size={15}
                    className="shrink-0 translate-y-0.5 text-slate-400"
                    aria-hidden
                  />
                  <span>
                    HMAC-signed{' '}
                    <span className="font-mono text-xs font-normal text-slate-500 dark:text-slate-400">
                      pk_live_…
                    </span>
                  </span>
                </h3>
                <dl className="mt-1 text-sm">
                  <HeaderRow name="X-Api-Key">your public key id</HeaderRow>
                  <HeaderRow name="X-Timestamp">
                    unix <strong>seconds</strong>
                  </HeaderRow>
                  <HeaderRow name="X-Signature">
                    {/* `break-words` rather than `break-all`: the expression has
                        spaces in it, so it should break at those first and only
                        split the quoted string — which is 45 unbreakable
                        characters and cannot fit a 360px line — when it has to.
                        `break-all` breaks greedily and mid-token even where a
                        space was available a few characters earlier. */}
                    <code className="code break-words">
                      hex( HMAC_SHA256( secret,
                      "&#123;ts&#125;.&#123;METHOD&#125;.&#123;path&#125;.&#123;sha256(body)&#125;"
                      ) )
                    </code>
                  </HeaderRow>
                </dl>
                <p className="measure mt-4 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
                  Required for <code className="code">POST /payouts</code>.{' '}
                  <code className="code">&#123;path&#125;</code> is the request
                  target exactly as sent — prefix and query string included, e.g.{' '}
                  <code className="code break-all">{`${PATH_PREFIX}/payouts?page=2`}</code>
                  . A body-less request hashes the empty string. Requests more
                  than 5 minutes from server time are rejected — keep your clock
                  on NTP.
                </p>
                <p className="measure mt-3 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
                  Older keys also accept the legacy{' '}
                  <code className="code break-words">
                    hex( HMAC_SHA256( secret, "&#123;ts&#125;.&#123;rawBody&#125;" ) )
                  </code>
                  , which binds neither the verb nor the path. Move to the form
                  above — it is what new keys will require.
                </p>
                <p className="measure mt-3 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
                  A signature sent on a <strong>write</strong> is single-use:
                  resending the identical request returns{' '}
                  <code className="code">401 Signature already used</code>. Retry
                  by re-signing with a fresh timestamp and the same{' '}
                  <code className="code">Idempotency-Key</code>. Reads are not
                  consumed, so polling is unaffected.
                </p>
              </div>

              <div className="min-w-0 border-t border-[var(--line-soft)] pt-6 xl:border-l xl:border-t-0 xl:pl-8 xl:pt-0">
                <h3 className="rule-b flex items-baseline gap-2.5 pb-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <KeyRound
                    size={15}
                    className="shrink-0 translate-y-0.5 text-slate-400"
                    aria-hidden
                  />
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
                <Specimen
                  runhead="Request · bearer mode"
                  title="POST /payments"
                  tabs={[{ label: 'curl', code: bearerSnippet }]}
                />
                <p className="measure mt-4 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
                  Bearer keys cannot hold{' '}
                  <code className="code">payouts:write</code>, so a leaked one
                  can read data and create payments but cannot move funds. Pair
                  it with an IP allowlist.
                </p>
              </div>
            </div>

            <Callout tone="warn" className="mt-6">
              <strong>
                If you integrated before August 2026, re-check your signing.
              </strong>{' '}
              An earlier version of this page documented{' '}
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
          </Chapter>

          {/* ---------------- ASSETS ---------------- */}
          <Chapter id="assets">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              A payment is a <strong>(network, asset)</strong> pair, fixed at
              creation. Omit <code className="code">network</code> for BEP20 and{' '}
              <code className="code">asset</code> for USDT, so existing
              integrations keep working. The table below is read live from this
              gateway — it is what you can actually charge today.
            </p>

            {assetsLoading ? (
              // `.ghost`, not a shimmer: static by design. See the motion note
              // at the top of this file.
              <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-x-8 gap-y-6">
                {[0, 1].map((i) => (
                  <div key={i}>
                    <span className="ghost h-4 w-20" />
                    <span className="ghost mt-4 h-3 w-full" />
                    <span className="ghost mt-3 h-3 w-4/5" />
                    <span className="ghost mt-3 h-3 w-3/5" />
                  </div>
                ))}
              </div>
            ) : Object.keys(byNetwork).length === 0 ? (
              <p className="measure mt-5 text-sm text-slate-500 dark:text-slate-400">
                Could not read the asset catalogue from the gateway.
              </p>
            ) : (
              <div className="mt-6 grid gap-x-8 gap-y-6 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
                {/* THE FIGURE. The live pair count, and deliberately absent
                    until /assets answers — a placeholder zero on a page about
                    what you can charge is a claim, and the wrong one. No
                    utility touches `.figure-lg`'s size: it is a fluid clamp,
                    and a `text-*` utility beside it would pin the number to one
                    size at every width. */}
                <div className="min-w-0">
                  <span className="runhead">Settleable now</span>
                  <span className="figure-lg mt-2">{pairCount}</span>
                  <span className="figure-label measure">
                    (network, asset) pairs, read from{' '}
                    <code className="code">/assets</code> on this gateway rather
                    than written into this page.
                  </span>
                </div>

                {/* `auto-fit` with a `min(100%, …)` floor rather than a column
                    count: the network panels reflow from three across to one
                    without a breakpoint, and the floor can never exceed the
                    track, so a narrow screen gets one full-width column instead
                    of a 13rem one overflowing a 12rem space. */}
                <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-x-8 gap-y-6">
                  {Object.entries(byNetwork).map(([network, list]) => (
                    <div key={network} className="min-w-0">
                      <div className="rule-b flex items-baseline justify-between gap-3 pb-1.5">
                        <h3 className="font-mono text-[13px] font-semibold text-slate-900 dark:text-slate-100">
                          {network}
                        </h3>
                        <span className="num shrink-0 text-xs text-slate-500 dark:text-slate-400">
                          {list.length} asset{list.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <ul>
                        {list.map((a) => (
                          <li
                            key={a.symbol}
                            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-[var(--line-soft)] py-2 first:border-t-0"
                          >
                            <span className="font-mono text-[13px] text-slate-800 dark:text-slate-200">
                              {a.symbol}
                              {a.isNative && (
                                <span className="ml-1.5 text-[11px] uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
                                  native
                                </span>
                              )}
                            </span>
                            {/* Wraps rather than truncates. An asset name
                                clipped to "Binance-Peg BSC-U…" is a name the
                                reader cannot check against their wallet. */}
                            <span className="min-w-0 break-words text-right text-[13px] text-slate-500 dark:text-slate-400">
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

            <Callout tone="danger" className="mt-6">
              A deposit address is valid <strong>only</strong> for the network it
              was issued on. Sending TRC20 funds to a BEP20 address — or any
              other cross-network mix-up — is unrecoverable. Never reuse an
              address across chains, and never assume decimals from the chain:
              USDT is 18 dp on BEP20 and 6 dp on ERC20 and TRC20. Send{' '}
              <code className="code">amount</code> as a human string like{' '}
              <code className="code">"50.00"</code> and let the gateway scale it.
            </Callout>
          </Chapter>

          {/* ---------------- CREATE ---------------- */}
          <Chapter id="create">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              <code className="code">POST /payments</code> returns a fresh
              deposit address and QR for the chosen pair. Always send an{' '}
              <code className="code">Idempotency-Key</code> — retrying without
              one creates a second payment and a second address for the same
              order.
            </p>

            <Specimen
              runhead="Request · four languages, one signature"
              title="POST /payments"
              tabs={createPaymentTabs}
            />

            <Specimen
              runhead="Response · 201 Created"
              tabs={[
                { label: 'Crypto-priced', code: responseCrypto },
                { label: 'Fiat-priced', code: responseFiat },
              ]}
            />
          </Chapter>

          {/* ---------------- FIAT ---------------- */}
          <Chapter id="fiat">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Send <code className="code">fiatAmount</code> and{' '}
              <code className="code">fiatCurrency</code> <em>instead of</em>{' '}
              <code className="code">amount</code> — supplying both, or neither,
              is rejected. The gateway converts at the market rate, locks it on
              the payment, and never revisits it, so the figure you quoted is the
              figure you reconcile.
            </p>

            <Specimen
              runhead="Request body"
              tabs={[{ label: 'JSON', code: fiatRequest }]}
            />

            <p className="measure-wide mt-5 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
              <code className="code">GET /rates</code> lists the currencies this
              gateway can price in, plus the rate source and its age in seconds.
              Check the age before showing a converted price — a stale quote is
              still a quote, and the caller is entitled to know.
            </p>
          </Chapter>

          {/* ---------------- ENDPOINTS ---------------- */}
          <Chapter id="endpoints">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Every endpoint a merchant can reach. List endpoints accept{' '}
              <code className="code">?page</code> and{' '}
              <code className="code">?limit</code> and return{' '}
              <code className="code">&#123; data, page, total &#125;</code>.
            </p>

            {/* SEVEN RULED LISTS, NOT SEVEN TABLES.
                This block used to be seven `<table class="ledger">`s inside
                horizontal scrollers, and a table cannot restack: at 360px the
                method, the path and the sentence explaining it competed for
                one line and the reader dragged the page sideways to read a
                reference. A grid row reflows instead — path beside the verb,
                description under it on a phone and beside it from `md` up — so
                nothing on this page scrolls horizontally except code, where
                horizontal is the honest shape.

                The group name is the running head over the rule the ledger's
                own header would have drawn, which is also why the column
                headings are not repeated seven times down the page. */}
            <div className="mt-6 space-y-7">
              {ENDPOINTS.map((g) => (
                <div key={g.group}>
                  <div className="rule-b flex items-baseline justify-between gap-4 pb-1.5">
                    <h3 className="runhead text-slate-700 dark:text-slate-200">
                      {g.group}
                    </h3>
                    <span className="num shrink-0 text-xs text-slate-500 dark:text-slate-400">
                      {g.rows.length}
                    </span>
                  </div>
                  <ul>
                    {g.rows.map(([method, path, desc]) => (
                      <RefRow
                        key={method + path}
                        cols={ROUTE_COLS}
                        lead={<MethodBadge method={method} />}
                        term={path}
                      >
                        <Ticks text={desc} />
                      </RefRow>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Chapter>

          {/* ---------------- WEBHOOKS ---------------- */}
          <Chapter id="webhooks">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              We POST to your configured URL as a payment moves. The hex
              signature arrives twice — in the{' '}
              <code className="code">signature</code> field of the body and in
              the <code className="code">X-Gateway-Signature</code> header — and
              the event name is also in{' '}
              <code className="code">X-Gateway-Event</code>.
            </p>

            <Callout tone="warn" className="mt-5">
              <strong>The signature does not cover the raw bytes.</strong> It is
              computed over the body with <code className="code">signature</code>{' '}
              set to <code className="code">""</code>. To verify: parse, blank
              the field, re-serialize compactly preserving key order, HMAC that,
              and compare in constant time. Hashing the raw body will never
              match.
            </Callout>

            <Specimen
              runhead="Verifying a delivery"
              title="your endpoint"
              tabs={webhookVerifyTabs}
            />

            <h3 className="runhead rule-b mt-7 pb-1.5 text-slate-700 dark:text-slate-200">
              Events
            </h3>
            <dl>
              {WEBHOOK_EVENTS.map(([name, desc]) => (
                <TermRow key={name} term={name}>
                  {desc}
                </TermRow>
              ))}
            </dl>

            <p className="measure-wide mt-5 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
              Deliveries retry with exponential backoff until they get a 2xx.
              Return 2xx immediately and do the work asynchronously; every
              attempt, status code and response body is recorded under{' '}
              <strong>Webhook logs</strong>. Fulfil idempotently — the same event
              can arrive more than once.
            </p>
          </Chapter>

          {/* ---------------- STATUSES ---------------- */}
          <Chapter id="statuses">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Fulfil on <code className="code">confirmed</code>, never earlier.
              Everything before it can still change.
            </p>
            <h3 className="runhead rule-b mt-6 pb-1.5 text-slate-700 dark:text-slate-200">
              Statuses
            </h3>
            <dl>
              {STATUSES.map(([status, desc]) => (
                <TermRow key={status} term={status}>
                  {desc}
                </TermRow>
              ))}
            </dl>
          </Chapter>

          {/* ---------------- ERRORS ---------------- */}
          <Chapter id="errors">
            <p className="measure-wide text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Every failure returns{' '}
              <code className="code break-words">
                &#123; "error": "code", "message": "…" &#125;
              </code>{' '}
              with a matching HTTP status. Branch on{' '}
              <code className="code">error</code>, not on the message text.
            </p>
            <h3 className="runhead rule-b mt-6 pb-1.5 text-slate-700 dark:text-slate-200">
              HTTP · code · meaning
            </h3>
            <ul>
              {ERRORS.map(([status, code, desc]) => (
                <RefRow
                  key={code}
                  cols={ERROR_COLS}
                  lead={
                    <span className="num font-mono text-[13px] text-slate-500 dark:text-slate-400">
                      {status}
                    </span>
                  }
                  term={code}
                >
                  {desc}
                </RefRow>
              ))}
            </ul>
            <p className="measure-wide mt-5 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
              Authenticated calls are throttled per API key (120 requests per
              minute by default) and responses carry the standard{' '}
              <code className="code">RateLimit-*</code> headers. On a{' '}
              <code className="code">429</code> or{' '}
              <code className="code">500</code>, retry with the <em>same</em>{' '}
              <code className="code">Idempotency-Key</code> — the gateway replays
              the original response instead of creating a second payment.
            </p>
          </Chapter>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/**
 * THE CHAPTER — one titled surface per section of the reference.
 *
 * It takes only an id and reads its own numeral and title out of `SECTIONS`,
 * which is the same array the index is built from. That is deliberate: the
 * numbers used to be typed twice, once in the contents column and once as a
 * literal on the heading, and a reference work whose index disagrees with its
 * body is worse than one with no index.
 *
 * The heading is a real `<h2>` at 18-20px rather than the `.runhead` a
 * dashboard `<Section>` carries. A running head names a block of data you can
 * see all of; a chapter of a document is a destination, and it has to be
 * findable by someone scrolling past at speed.
 */
function Chapter({ id, children }: { id: SectionId; children: ReactNode }) {
  const { n, label } = CHAPTER[id];
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="surface scroll-mt-4 px-4 py-5 sm:px-6 sm:py-6"
    >
      <div className="flex items-baseline gap-3">
        <span className="runhead num shrink-0">{n}</span>
        <h2
          id={`${id}-title`}
          className="text-lg font-semibold tracking-[-0.025em] text-slate-900 sm:text-xl dark:text-slate-50"
        >
          {label}
        </h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The index, rendered twice — once in the sticky desktop rail, once inside the
 * phone disclosure. One component rather than two copies, because an index that
 * lists eight sections on a laptop and seven on a phone is exactly the bug
 * nobody notices until a reader reports it.
 *
 * Only one of the two is ever in the accessibility tree: the other's ancestor
 * is `display: none`, so there is no duplicate landmark to tab through.
 */
function TocList({
  active,
  onNavigate,
}: {
  active: string | null;
  onNavigate?: () => void;
}) {
  return (
    <ol>
      {SECTIONS.map(([id, label], i) => {
        const on = active === id;
        return (
          <li key={id}>
            <a
              href={`#${id}`}
              onClick={onNavigate}
              aria-current={on ? 'true' : undefined}
              // `.nav-item` is the product's own navigation row, so the index
              // reads as navigation rather than as a second, invented control.
              // Its 38px floor is a desktop measurement; on a phone this list
              // is thumbed, so it is lifted to the 44px touch floor and only
              // relaxes where there is a pointer.
              className={`nav-item min-h-[44px] lg:min-h-[38px] ${on ? 'nav-item-on' : ''}`}
            >
              <span className="num shrink-0 text-[11px] tracking-[0.12em] text-slate-400 dark:text-slate-500">
                {ord(i)}
              </span>
              <span className="min-w-0">{label}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * A CODE SPECIMEN — the shared `<CodeBlock>` with a caption over it.
 *
 * The block itself is `.well`, the inset surface, and that is the right reading
 * of what a snippet is: the chapter around it is the object, and the sample is
 * a window cut into it. A raised, shadowed card would put the code on the same
 * plane as the section containing it.
 *
 * All this component adds is the running head. An unlabelled snippet in a
 * reference this long is a puzzle — "which of the four things I just read is
 * this?" — and the caption is also what carries the route for the two blocks
 * whose chrome has no room for it on a phone.
 */
function Specimen({ runhead, tabs, title }: SpecimenProps) {
  return (
    <div className="mt-5">
      <span className="runhead mb-1.5">{runhead}</span>
      <CodeBlock tabs={tabs} title={title} />
    </div>
  );
}

/**
 * One request header, as a label/value row.
 *
 * The label column used to be a fixed `7.25rem` at every width, which on a
 * 360px screen left about 130px for a value that is sometimes a 90-character
 * HMAC expression. It is one column below `sm` and a fixed pair only where
 * there is room for one — and the values that need it carry their own wrapping
 * at the call site, because a signed string is 45 unbreakable characters and
 * would otherwise set the whole page's minimum width on its own.
 */
function HeaderRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-3 gap-y-1 border-t border-[var(--line-soft)] py-2 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <dt className="min-w-0">
        <code className="code">{name}</code>
      </dt>
      <dd className="min-w-0 text-slate-600 dark:text-slate-300">{children}</dd>
    </div>
  );
}

/**
 * A three-field reference row: a short lead (the verb, the status), the thing
 * being named, and a sentence about it.
 *
 * The whole responsive trick is two grid placements. Where the row is narrow
 * the description is pushed to `col-start-2`, so it drops onto a second row and
 * aligns under the path rather than under the verb; where it is wide it is
 * pulled back up to `row-start-1` in a third column. One row of markup, two
 * shapes, and the path never has to be truncated or scrolled to fit.
 *
 * The placement follows ROUTE_COLS / ERROR_COLS step for step, including the
 * reversal at `lg` — see the note on those constants.
 */
function RefRow({
  lead,
  term,
  cols,
  children,
}: {
  lead: ReactNode;
  term: string;
  cols: string;
  children: ReactNode;
}) {
  return (
    <li
      className={`grid grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-t border-[var(--line-soft)] py-2.5 first:border-t-0 md:gap-x-4 ${cols}`}
    >
      {lead}
      <code className="min-w-0 break-all font-mono text-[13px] text-slate-900 dark:text-slate-100">
        {term}
      </code>
      <p className="col-start-2 min-w-0 text-[13px] leading-relaxed text-slate-600 dark:text-slate-400 md:col-start-3 md:row-start-1 lg:col-start-2 lg:row-start-auto xl:col-start-3 xl:row-start-1">
        {children}
      </p>
    </li>
  );
}

/** A two-field reference row — an event name or a status, and what it means. */
function TermRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-x-4 gap-y-1 border-t border-[var(--line-soft)] py-2.5 first:border-t-0 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
      <dt className="min-w-0 break-all font-mono text-[13px] text-slate-900 dark:text-slate-100">
        {term}
      </dt>
      <dd className="min-w-0 text-[13px] leading-relaxed text-slate-600 dark:text-slate-400">
        {children}
      </dd>
    </div>
  );
}

/**
 * Renders the backticks the endpoint descriptions are already written with as
 * real inline code. The copy is unchanged — it was always marked up this way,
 * and the marks were simply being printed as literal characters.
 */
function Ticks({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="code break-all">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function MethodBadge({ method }: { method: string }) {
  // Method colour is structural, not semantic-financial: it says "this reads"
  // vs "this writes". Green stays out of it — on this product green means money
  // arrived, and a GET badge is not a settled payment. Brand is out of it too:
  // an indigo fill on a label nobody can click spends the interactive colour on
  // decoration. The word is the carrier, weight is the emphasis, and the mark
  // survives in greyscale.
  const tone =
    method === 'GET'
      ? 'text-slate-500 dark:text-slate-400'
      : method === 'DELETE'
        ? 'text-red-600 dark:text-red-400'
        : 'text-slate-900 dark:text-slate-100';
  return (
    <span
      className={`font-mono text-[11px] font-semibold uppercase tracking-[0.1em] ${tone}`}
    >
      {method}
    </span>
  );
}

/**
 * A CAUTION, SET INTO THE PAGE.
 *
 * A `.well` with one semantic edge rather than a tinted rounded box: the note
 * is an aside cut into the chapter, and the colour is spent on a 2px stroke and
 * a label instead of on a fill nobody can read small type against.
 *
 * The hue still means what it means everywhere else in the product — amber is
 * "wait, there is something you have to do", red is "you can lose money here" —
 * and the WORD carries the same meaning on its own, so the distinction survives
 * in greyscale and for a red/green-blind reader. The body stays in ink on a
 * measure, because it is the part that has to be read.
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
    ? 'border-l-red-600 dark:border-l-red-400'
    : 'border-l-amber-600 dark:border-l-amber-400';
  const ink = danger
    ? 'text-red-600 dark:text-red-400'
    : 'text-amber-600 dark:text-amber-400';
  return (
    <div className={`well border-l-2 p-3.5 sm:p-4 ${stroke} ${className}`}>
      <p className={`runhead flex items-center gap-2 ${ink}`}>
        <AlertTriangle size={13} className="shrink-0" aria-hidden />
        {danger ? 'Unrecoverable' : 'Important'}
      </p>
      <div className="measure-wide mt-2 text-[13px] leading-relaxed text-slate-700 dark:text-slate-300">
        {children}
      </div>
    </div>
  );
}
