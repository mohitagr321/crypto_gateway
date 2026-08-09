# Merchant Onboarding

This guide takes a merchant from zero to accepting USDT (BEP20) payments in
production. It covers registration, admin approval, credentials, webhook and
payout configuration, your first payment, webhook handling, and a go-live
checklist.

- **Currency / network:** USDT on Binance Smart Chain (BEP20), contract
  `0x55d398326f99059fF775485246999027B3197955`, **18 decimals**.
- **API base:** `https://gateway.example.com/api/v1` (or
  `http://localhost:4000/api/v1` in dev).
- **Auth:** merchant API endpoints use `X-Api-Key` + `X-Timestamp` +
  `X-Signature` (HMAC-SHA256). See the SDK docs for exact signing:
  [JavaScript](./sdk/javascript.md) · [Python](./sdk/python.md) · [PHP](./sdk/php.md).

---

## Step 1 — Register

Self-registration is open by default (`SIGNUP_ENABLED=true`). There is **no
approval queue** — verifying your email activates the account.

1. Open the **Client Panel** (dev: `http://localhost:5174`) and choose
   **Get started**.
2. Enter your work email and a password (10 characters minimum), then your
   business name, and optionally a website and country.
3. This creates a `users` row (role `merchant`, `email_verified = false`) and a
   `clients` row with `status = 'pending'` and `signup_source = 'self'`. A
   default commission is applied immediately, so you are never silently on 0%.
   **No API key is issued yet** — see Step 3 for why.

The response is deliberately identical whether or not that address already has
an account: the API never confirms which. If the address was already registered,
the real owner is emailed a notice instead and nothing is created.

If `SIGNUP_ENABLED=false`, the signup routes return 404 and the panel hides them.
Ask your operator to provision you via `POST /admin/clients` instead; the rest of
this guide is unchanged.

## Step 2 — Verify your email

Click the link in the confirmation email. It expires in
`EMAIL_VERIFY_TTL_HOURS` (default 24) and works exactly once.

- `users.email_verified` becomes true.
- `clients.status` flips `pending` → `approved`, with `approved_by = NULL` —
  nobody approved you, the email proved itself. This is written to `audit_logs`
  as `client.self_approve`.
- You are signed in automatically and land on the **Get started** checklist.

Didn't get it? Use **Resend the link** on the check-your-inbox screen, or sign in
with your password — an unverified account can still log in, and lands on the
same checklist with a resend button. It just cannot transact:
`requireApprovedClient` rejects a `pending` client.

**In development**, leave `SMTP_HOST` empty. The mailer logs each message,
including the link, at info level instead of sending it — copy it from the
console. In production the app refuses to boot with signup on and no SMTP.

## Step 3 — Add a settlement wallet, THEN create an API key

The checklist enforces this order deliberately: **a key with nowhere to settle
collects confirmed payments you cannot withdraw**. Set the wallet first.

In **Settings**, set your BEP20 payout address (and the TRC20 one if this gateway
settles on Tron). Then in **API Keys**, choose a mode:

| | HMAC-signed (`pk_live_…`) | Bearer (`ak_live_…`) |
|---|---|---|
| Sent | Public id + a signature per request | The token itself, every request |
| Secret on the wire | Never | Every call |
| `payouts:write` | Yes | **Never granted** |
| Use when | Production, and anything that moves money | Storefront plugins, prototypes |

The **secret is shown exactly once**, at creation. The server stores the HMAC
secret envelope-encrypted (it must recompute signatures) and a bearer token only
as a SHA-256 digest (it never needs to read it back). Lose it and you revoke and
re-issue — there is no recovery.

You can hold several keys at once; give each integration its own so you can
revoke one without breaking the others.

```bash
export GATEWAY_API_KEY=pk_live_xxxxxxxx
export GATEWAY_API_SECRET=sk_live_yyyyyyyy
export GATEWAY_BASE_URL=https://gateway.example.com/api/v1
```

### What an API key can NEVER do

Changing your **payout wallet**, your **password**, your **IP allowlist** or your
**set of API keys** requires a signed-in dashboard session. No API key of either
mode can reach those endpoints — they return 401. This is what stops a leaked
credential from quietly redirecting your settlements to someone else's address.

If you use a bearer key, **set an IP allowlist** (Settings → IP allowlist). It is
enforced on every API request for both key modes; empty means unrestricted.

## Step 4 — Configure your webhook URL

In the Client Panel → Settings:

1. **Webhook URL** (`clients.webhook_url`) — a public HTTPS endpoint that
   receives `payment.confirmed` events. The gateway generates a per-client
   **webhook secret** (`clients.webhook_secret`, stored encrypted) — copy it and
   set `GATEWAY_WEBHOOK_SECRET` in your app to verify signatures.
2. **Payout wallet** (`clients.payout_wallet`) — set in Step 3. The BEP20 address
   that receives your settlements (net of commission + any network fee).
   **Double-check it**; payouts are irreversible.
3. **IP allowlist** (`clients.ip_whitelist`) — restrict which source IPs may call
   the API with your keys. Enforced on every request when non-empty; empty means
   unrestricted. Strongly recommended in production, and close to mandatory if
   you use a bearer key.

## Step 5 — Create your first payment

Send a signed `POST /payments`. Always include an `Idempotency-Key` (your
`orderId` works well) so a network retry never creates two payments.

```bash
# Illustrative curl — see SDK docs for the exact HMAC signing helper.
# X-Signature = hex HMAC-SHA256 over "<timestamp>.<raw-json-body>" with your API secret.
curl -X POST "$GATEWAY_BASE_URL/payments" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $GATEWAY_API_KEY" \
  -H "X-Timestamp: 1720089600" \
  -H "X-Signature: <hex-hmac-sha256>" \
  -H "Idempotency-Key: order_789" \
  -d '{"amount":"50.00","orderId":"order_789","description":"Order #789 — Pro plan"}'
```

Response (`201`):

```json
{
  "paymentId": "pay_01HZY...",
  "orderId": "order_789",
  "amount": "50.00",
  "amountReceived": "0",
  "currency": "USDT",
  "network": "BEP20",
  "address": "0xabc...",
  "qrCode": "data:image/png;base64,...",
  "status": "waiting",
  "confirmations": 0,
  "expiresAt": "2026-07-04T12:30:00Z",
  "createdAt": "2026-07-04T12:00:00Z"
}
```

Show the customer `address` and `qrCode`, and display the countdown to
`expiresAt` (default 30 min). Each payment gets a **fresh HD-derived deposit
address**.

## Step 6 — Handle the webhook

When the deposit reaches `REQUIRED_CONFIRMATIONS` (default 12) the gateway
`POST`s a `payment.confirmed` event to your `webhook_url`:

```json
{
  "event": "payment.confirmed",
  "paymentId": "pay_01HZY...",
  "orderId": "order_789",
  "amount": "50.00",
  "txHash": "0x...",
  "status": "confirmed",
  "signature": "<hex-hmac-sha256-of-raw-body-with-your-webhook-secret>"
}
```

Your receiver must:

1. **Verify the signature** over the raw body with your webhook secret, in
   constant time (see SDK webhook receivers).
2. **Be idempotent** — key fulfillment on `paymentId`; you may receive retries
   (up to `WEBHOOK_MAX_RETRIES`, default 8).
3. **Respond `200` quickly** — do heavy work asynchronously; a non-2xx or
   timeout (`WEBHOOK_TIMEOUT_MS`, default 8000) triggers a retry with backoff.
4. Optionally **reconcile** by calling `GET /payments/{id}` before fulfilling.

Do not treat a `waiting`→`confirming` transition as paid — only `confirmed`
(≥ required confirmations) is final for fulfillment.

## Payment lifecycle / state diagram

```
 waiting ──(tx seen, <N conf)──► confirming ──(≥N conf)──► confirmed ──► swept
    │                                                          │
    └──(expiry timer, no funds)──► expired      (partial pay)──┴──► partial
                                    failed  ◄── (reorg drops tx / underpaid final)
```

| Status       | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `waiting`    | Address issued, no funds seen yet. Expires at `expiresAt`.               |
| `confirming` | Deposit tx seen on-chain, `< N` confirmations.                          |
| `confirmed`  | `≥ N` confirmations — **safe to fulfill**. `payment.confirmed` fires.   |
| `partial`    | Received less than `amount`. Await top-up or resolve out-of-band.       |
| `swept`      | Funds swept from the deposit address to the central wallet.             |
| `expired`    | Timer elapsed with no (sufficient) funds.                              |
| `failed`     | Reorg dropped the tx, or a final underpayment.                         |

## Full flow (sequence)

```
Customer        Merchant server        Gateway API        Listener/Workers        BSC
   │                 │                      │                    │                  │
   │  checkout       │                      │                    │                  │
   │────────────────►│  POST /payments      │                    │                  │
   │                 │─────────(HMAC)──────►│                    │                  │
   │                 │   201 {address,qr}   │                    │                  │
   │  show QR/addr   │◄─────────────────────│                    │                  │
   │◄────────────────│                      │                    │                  │
   │       send USDT to deposit address ───────────────────────────────────────────►│
   │                 │                      │   Transfer log     │◄─────────────────│
   │                 │                      │                    │ match addr, write │
   │                 │                      │                    │ btx, status=      │
   │                 │                      │                    │ confirming        │
   │                 │                      │                    │  ...N confs...     │
   │                 │                      │                    │ status=confirmed  │
   │                 │  POST webhook        │                    │ enqueue webhook   │
   │                 │◄──(payment.confirmed,signature)───────────│                  │
   │                 │  verify sig, 200     │                    │                  │
   │                 │─────────────────────►│                    │                  │
   │  order fulfilled│                      │                    │ sweep→central     │
   │◄────────────────│                      │                    │ (gas top-up first)│
   │                 │                      │                    │ payout→payout_    │
   │                 │                      │                    │ wallet (net)      │
```

## Go-live checklist

- [ ] Account `status = 'approved'` and commission set.
- [ ] API key + secret stored in a secret manager (never in source control).
- [ ] Requests signed correctly; clock NTP-synced (timestamp skew < 5 min).
- [ ] `Idempotency-Key` sent on every `POST /payments`.
- [ ] Webhook endpoint is **HTTPS**, publicly reachable, verifies the signature
      in constant time, is idempotent, and returns `200` fast.
- [ ] Webhook secret stored securely; separate from the API secret.
- [ ] Payout wallet address verified on-chain and controlled by you.
- [ ] IP whitelist configured (production).
- [ ] You only fulfill on `confirmed` (not `waiting`/`confirming`).
- [ ] Amounts handled as **strings** (18-decimal USDT); no float rounding.
- [ ] Expiry handled in your UI (`expiresAt`, default 30 min).
- [ ] Error handling for `401` (bad signature), `404`, `429` (rate limit).
- [ ] Reconciliation job that periodically `GET /payments` to catch missed
      webhooks.
- [ ] Tested against the local stack (`docker compose up`) before switching to
      the production base URL.

## If a customer sends the wrong coin

Nothing is lost, and you do not need to contact support.

A deposit address expects one specific asset. If a customer sends a *different*
supported coin to it — USDC to a USDT invoice — the gateway does **not** credit
it to the payment. Crediting it would put the wrong asset into a balance you can
withdraw, at 1:1, which is a real loss the moment the two are not the same price.

Instead it appears under **Unexpected deposits** in your panel, with what
arrived and what was expected. Press **Recover** and the funds are swept into the
collection wallet, where they settle to you like any other balance of that asset.

The same page catches **late payments** — the right coin arriving after the
payment window closed. Same treatment, same button.

Until you recover it the money sits at an address derived from your account's
own key. It is not going anywhere.

**Converting** a recovered asset into a different one (say USDC into USDT) is a
separate, opt-in setting and is **off by default**: converting realises a price
and a fee on your behalf, which is not a decision the gateway should make for
you.
