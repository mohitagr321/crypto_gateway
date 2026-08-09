# Merchant (Client) Panel — USDT (BEP20) Payment Gateway

A React + Vite + TypeScript + Tailwind dashboard for merchants of the USDT
(BEP20) crypto payment gateway. Merchants sign in with a JWT (email/password)
and manage payments, payouts, API keys, webhooks, commission and reports.

> The dashboard talks to **JWT-authenticated** dashboard endpoints. The
> programmatic REST API (used from your backend) authenticates with **API key +
> HMAC** — the signing scheme is documented in-app under **API Docs**.

## Tech stack

- React 18, React Router v6
- @tanstack/react-query (data fetching, caching, polling)
- axios (typed API client with JWT Bearer + 401 handling)
- Tailwind CSS (class-based dark mode)
- recharts (dashboard charts)
- lucide-react (icons)
- react-hook-form (forms + validation)
- qrcode.react (payment QR codes)

## Getting started

```bash
cp .env.example .env         # set VITE_API_BASE_URL (and optionally VITE_BSCSCAN_URL)
npm install
npm run dev                  # http://localhost:5173
```

### Scripts

| Script            | Description                          |
| ----------------- | ------------------------------------ |
| `npm run dev`     | Start the Vite dev server            |
| `npm run build`   | Type-check (`tsc`) + production build |
| `npm run preview` | Preview the production build         |
| `npm run lint`    | Lint the codebase                    |

## Environment

| Variable             | Default                             | Purpose                          |
| -------------------- | ----------------------------------- | -------------------------------- |
| `VITE_API_BASE_URL`  | `http://localhost:4000/api/v1`      | Gateway REST API base URL        |
| `VITE_BSCSCAN_URL`   | `https://bscscan.com`               | Block explorer for tx / address  |

`VITE_*` values are **baked at build time**. For Docker, pass them as build args.

## Routes / pages

| Route             | Page          | What it does                                                        |
| ----------------- | ------------- | ------------------------------------------------------------------ |
| `/login`          | Login         | JWT login (email/password, optional MFA token)                     |
| `/dashboard`      | Dashboard     | StatCards + volume area chart + status pie                         |
| `/payments/new`   | CreatePayment | Create payment → QR, address, countdown, live status polling      |
| `/payments`       | Payments      | History table with search + status filter + pagination            |
| `/payments/:id`   | PaymentDetail | Full info, QR, status timeline, BscScan tx link, live polling     |
| `/payouts`        | Payouts       | Request payout + payout history                                    |
| `/reports`        | Reports       | Date-range filter + client-side CSV export                        |
| `/commission`     | Commission    | Read-only fee schedule + worked example                           |
| `/api-keys`       | ApiKeys       | Show public key, regenerate (secret shown once), header example   |
| `/webhook-logs`   | WebhookLogs   | Delivery attempts, expandable payloads                            |
| `/settings`       | Settings      | Webhook URL + payout wallet (validated), HMAC secret note         |
| `/docs`           | ApiDocs       | curl / JS / Python / PHP examples + HMAC + webhook verification    |

All routes except `/login` are protected by `ProtectedRoute`; a `401` from the
API forces a logout.

## Docker

```bash
docker build \
  --build-arg VITE_API_BASE_URL=https://gateway.example.com/api/v1 \
  -t gateway-client-panel .

docker run -p 8080:80 gateway-client-panel   # http://localhost:8080
```

Multi-stage: builds with Node 20, serves the static SPA from `nginx:80` with an
SPA fallback (`nginx.conf`).

## API endpoints consumed

Dashboard (JWT): `POST /auth/login`, `GET /payments`, `GET /payments/:id`,
`POST /payments`, `GET /balance`, `GET/POST /payouts`,
`GET /account/api-keys`, `POST /account/api-keys/regenerate`,
`GET/PUT /account/settings`, `GET /account/commission`,
`GET /account/webhook-logs`.

All are typed in `src/lib/api.ts`; domain models live in `src/types.ts`.

## Notes / assumptions

- The brief specifies JWT dashboard endpoints that mirror the merchant REST
  resources (the OpenAPI spec only formally documents the HMAC-auth variants).
  These are typed and called exactly as listed above.
- List endpoints tolerate either a bare array or a `{ data, page, total }`
  envelope (payouts / webhook logs), matching the paginated payments shape.
- `REQUIRED_CONFIRMATIONS` defaults to 12 (per repo `.env.example`) for the
  confirmation progress UI.
- The payment QR uses the server-provided `qrCode` data URI when present, else
  renders the deposit address client-side via `qrcode.react`.
```
