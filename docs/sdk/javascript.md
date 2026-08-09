# Node.js SDK

A minimal, dependency-light client for the Crypto Payment Gateway (USDT / BEP20).

- Merchant endpoints authenticate with **API key + HMAC-SHA256 signature**.
- Webhooks are verified with a **per-client webhook secret**.

## Auth scheme (must match exactly)

Every merchant request sends three headers:

| Header        | Value                                                              |
|---------------|-------------------------------------------------------------------|
| `X-Api-Key`   | Your public API key (e.g. `pk_live_...`)                           |
| `X-Timestamp` | Current unix time **in seconds**                                   |
| `X-Signature` | `hex( HMAC_SHA256( secret, "${timestamp}.${rawJsonBody}" ) )`      |

Rules:

- The signature is computed over the **exact raw JSON string** that is sent on the wire. Serialize the body **once** and reuse that exact string for both signing and sending — do not re-`JSON.stringify` it.
- For requests with no body (GET), the raw body is the **empty string** `""`, so you sign `"${timestamp}."`.
- Requests whose timestamp is more than **5 minutes** (300 s) off the server clock are rejected (replay protection). Keep your clock in sync (NTP).
- Send `Content-Type: application/json`.


## Two key modes

Your account can hold API keys of two kinds. Pick per integration in the Client
Panel → API Keys.

| | **HMAC-signed** (`pk_live_…`) | **Bearer** (`ak_live_…`) |
|---|---|---|
| Headers | `X-Api-Key` + `X-Timestamp` + `X-Signature` | `X-Api-Key` only |
| Secret on the wire | Never | Every request |
| `payouts:write` | Yes | **Never granted** |
| Use for | Production; anything that moves money | Storefront plugins, prototypes |

A bearer key is one opaque token sent alone — no signing:

```
X-Api-Key: ak_live_3ea4f5c5e51ad13eba4ed653a8de1ffd197db3af17b81cf218c20b8d7f93f8eb
Content-Type: application/json
```

The trade-off is real: that token is on the wire on every call, so it lands in
proxy logs, shell history and screenshots. The gateway compensates by refusing to
grant it `payouts:write` — a leaked bearer key can create payments and read your
data, but **cannot move funds**. Pair it with an IP allowlist (Settings → IP
allowlist), which is enforced on every request when non-empty.

**Do not mix the modes.** Sending an HMAC key without a signature, or a bearer
token with one, is rejected with 401 rather than falling back — a silent
fallback would let anyone downgrade to the weaker path by omitting headers.

Whichever you use, no API key can change your payout wallet, your password or
your set of keys. Those require a signed-in dashboard session, which is what
stops a leaked credential from redirecting your settlements.


## Install

```bash
npm install axios
# crypto is built into Node.js (>=16)
```

## `GatewayClient`

```js
// gateway-client.js
const crypto = require('crypto');
const axios = require('axios');

class GatewayClient {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey    - public API key (pk_live_...)
   * @param {string} opts.apiSecret - API secret (shown once at creation)
   * @param {string} [opts.baseUrl] - e.g. https://gateway.example.com/api/v1
   * @param {number} [opts.timeout] - request timeout in ms
   */
  constructor({ apiKey, apiSecret, baseUrl = 'http://localhost:4000/api/v1', timeout = 15000 }) {
    if (!apiKey || !apiSecret) throw new Error('apiKey and apiSecret are required');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.http = axios.create({ baseURL: baseUrl, timeout });
  }

  /** Sign "${timestamp}.${rawBody}" with the API secret -> hex. */
  _sign(timestamp, rawBody) {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
  }

  /**
   * Core signed request. Serializes the body ONCE and signs that exact string.
   * @param {'GET'|'POST'|'PUT'} method
   * @param {string} path                - e.g. '/payments'
   * @param {object} [opts]
   * @param {object} [opts.body]         - JSON body (POST/PUT)
   * @param {object} [opts.query]        - query params (GET)
   * @param {object} [opts.headers]      - extra headers (e.g. Idempotency-Key)
   */
  async _request(method, path, { body, query, headers = {} } = {}) {
    const rawBody = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this._sign(timestamp, rawBody);

    const res = await this.http.request({
      method,
      url: path,
      params: query,
      // send the SAME string we signed; disable axios re-serialization
      data: rawBody === '' ? undefined : rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': this.apiKey,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
        ...headers,
      },
      transformRequest: [(d) => d], // keep our raw string as-is
    });
    return res.data;
  }

  // ---- Payments ----------------------------------------------------------
  /** Create a payment; returns { paymentId, address, qrCode, status, ... } */
  createPayment({ amount, orderId, description }, { idempotencyKey } = {}) {
    const headers = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
    return this._request('POST', '/payments', { body: { amount, orderId, description }, headers });
  }

  /** Retrieve a single payment by id. */
  getPayment(paymentId) {
    return this._request('GET', `/payments/${encodeURIComponent(paymentId)}`);
  }

  /** List payments (paginated). */
  listPayments({ status, page = 1, limit = 25 } = {}) {
    return this._request('GET', '/payments', { query: { status, page, limit } });
  }

  // ---- Account & payouts -------------------------------------------------
  /** Merchant available/pending balance. */
  getBalance() {
    return this._request('GET', '/balance');
  }

  /** Request a payout to the configured payout wallet. */
  requestPayout({ amount }) {
    return this._request('POST', '/payouts', { body: { amount } });
  }
}

module.exports = { GatewayClient };
```

## Usage examples

```js
// examples.js
const { GatewayClient } = require('./gateway-client');

const client = new GatewayClient({
  apiKey: process.env.GATEWAY_API_KEY,
  apiSecret: process.env.GATEWAY_API_SECRET,
  baseUrl: process.env.GATEWAY_BASE_URL || 'http://localhost:4000/api/v1',
});

async function main() {
  // 1) Create a payment (send an Idempotency-Key so retries don't double-charge)
  const payment = await client.createPayment(
    { amount: '50.00', orderId: 'order_789', description: 'Order #789 — Pro plan' },
    { idempotencyKey: 'order_789' }
  );
  console.log('Pay to:', payment.address);
  console.log('Status:', payment.status);           // waiting
  console.log('Expires:', payment.expiresAt);
  // payment.qrCode is a base64 data URI you can render in an <img src=...>

  // 2) Poll a single payment
  const fresh = await client.getPayment(payment.paymentId);
  console.log('Now:', fresh.status, fresh.confirmations, 'confs');

  // 3) List recent confirmed payments
  const list = await client.listPayments({ status: 'confirmed', page: 1, limit: 25 });
  console.log(`Total confirmed: ${list.total}`);

  // 4) Check balance and request a payout
  const balance = await client.getBalance();
  console.log(`Available: ${balance.available} ${balance.currency}`);
  if (Number(balance.available) > 0) {
    await client.requestPayout({ amount: balance.available });
    console.log('Payout queued.');
  }
}

main().catch((err) => {
  console.error('Gateway error:', err.response?.status, err.response?.data || err.message);
  process.exit(1);
});
```

## Express webhook receiver

The gateway `POST`s a JSON body to your `webhook_url` when a payment reaches
`confirmed`. The body carries a `signature` field = `hex HMAC-SHA256` of the
**raw JSON body** using **your webhook secret**.

Verify against the **raw bytes** you received — parsing and re-stringifying the
JSON can change key order/spacing and break the signature. Compare with a
constant-time comparison.

```js
// webhook-server.js
const express = require('express');
const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.GATEWAY_WEBHOOK_SECRET; // per-client secret

const app = express();

// Capture the RAW body so we can verify the signature over exact bytes.
app.use('/webhooks/gateway', express.raw({ type: '*/*' }));

/**
 * The `signature` field is HMAC over the raw body. Since the field is itself
 * part of the JSON, the gateway signs the body with the signature field
 * removed (empty), then injects the hex digest. To verify, recompute the HMAC
 * over the body with the signature field blanked out and compare.
 *
 * If your gateway instead signs the payload *without* the signature key at all,
 * verify against that canonical form. The helper below strips the signature
 * value before hashing, matching the documented scheme.
 */
function verify(rawBuffer, secret) {
  const parsed = JSON.parse(rawBuffer.toString('utf8'));
  const provided = parsed.signature || '';
  // Rebuild the exact signed payload: same body with signature set to "".
  const unsigned = JSON.stringify({ ...parsed, signature: '' });
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length) return { ok: false, parsed };
  return { ok: crypto.timingSafeEqual(a, b), parsed };
}

app.post('/webhooks/gateway', (req, res) => {
  const { ok, parsed } = verify(req.body, WEBHOOK_SECRET);
  if (!ok) return res.status(401).json({ error: 'invalid_signature' });

  // Signature valid — process idempotently (you may receive retries).
  switch (parsed.event) {
    case 'payment.confirmed':
      console.log('Confirmed', parsed.paymentId, parsed.orderId, parsed.amount, parsed.txHash);
      // fulfill the order here; make it idempotent on parsed.paymentId
      break;
    default:
      console.log('Unhandled event', parsed.event);
  }

  // Acknowledge quickly (200) so the gateway stops retrying.
  return res.status(200).json({ received: true });
});

app.listen(3000, () => console.log('Webhook receiver on :3000'));
```

> Note on the signed form: this gateway computes `signature` as HMAC of the raw
> body with the `signature` field empty, then fills it in. Always verify against
> the same canonical form your gateway uses. Whichever form it is, verify over
> the **raw** received bytes, use the **webhook secret** (not the API secret),
> and compare in **constant time**.

## Runnable snippet

Save as `snippet.js`, then `GATEWAY_API_KEY=... GATEWAY_API_SECRET=... node snippet.js`.

```js
const crypto = require('crypto');
const axios = require('axios');

const BASE = process.env.GATEWAY_BASE_URL || 'http://localhost:4000/api/v1';
const KEY = process.env.GATEWAY_API_KEY;
const SECRET = process.env.GATEWAY_API_SECRET;

async function createPayment(amount, orderId) {
  const raw = JSON.stringify({ amount, orderId });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${raw}`).digest('hex');
  const { data } = await axios.post(`${BASE}/payments`, raw, {
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': KEY,
      'X-Timestamp': ts,
      'X-Signature': sig,
      'Idempotency-Key': orderId,
    },
    transformRequest: [(d) => d],
  });
  return data;
}

createPayment('50.00', `order_${Date.now()}`)
  .then((p) => console.log('Send USDT to:', p.address, '| status:', p.status))
  .catch((e) => console.error(e.response?.data || e.message));
```
