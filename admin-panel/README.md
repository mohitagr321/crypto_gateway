# Crypto Gateway — Admin Panel

React + Vite + TypeScript + Tailwind admin panel for the USDT (BEP20) crypto payment gateway.

Manage merchant clients, monitor on-chain transactions, configure per-client
commissions, trigger payouts, inspect webhook delivery, and view revenue analytics.

## Stack

- React 18 + Vite + TypeScript
- React Router v6
- TanStack Query (server state, loading/empty/error handling)
- Axios (JWT Bearer, 401 -> /login)
- Tailwind CSS (dark mode via `class` strategy)
- Recharts (dashboards & analytics)
- react-hook-form (forms)
- lucide-react (icons)

## Getting started

```bash
cp .env.example .env       # set VITE_API_BASE_URL if not localhost:4000
npm install
npm run dev                # http://localhost:5174
```

Build for production:

```bash
npm run build              # type-checks then bundles to dist/
npm run preview            # serve the production build locally
```

## Environment

| Variable            | Description                                   | Default                          |
| ------------------- | --------------------------------------------- | -------------------------------- |
| `VITE_API_BASE_URL` | Gateway API base (must include `/api/v1`)     | `http://localhost:4000/api/v1`   |

`VITE_*` vars are baked at build time. For Docker, pass `--build-arg VITE_API_BASE_URL=...`.

## Auth & roles

- Login: email + password. Admin accounts require a TOTP MFA token. If the API
  responds with `mfaRequired`, the login form reveals the MFA field and re-submits.
- The JWT is stored in `localStorage`; every request sends `Authorization: Bearer`.
  A `401` clears the session and redirects to `/login`.
- Roles:
  - **super_admin** — full access (commission editing, key regeneration, approvals).
  - **ops** — read-only subset: no commission edits, no key regeneration; the
    Commissions page is hidden and destructive actions are disabled.

Role is enforced in three layers: `Sidebar` (nav filtering), `ProtectedRoute`
(route guards), and per-action disabling in the pages.

## Routes / pages

| Route             | Page            | Notes                                              |
| ----------------- | --------------- | -------------------------------------------------- |
| `/login`          | Login           | email/password + MFA                               |
| `/`               | Dashboard       | stat cards + volume/revenue charts                 |
| `/clients`        | Clients         | approve / suspend / regenerate keys; secret shown once |
| `/clients/:id`    | ClientDetail    | info, commission editor, webhook, payout wallet, recent payments |
| `/transactions`   | Transactions    | global monitoring with filters + BscScan links     |
| `/payouts`        | Payouts         | history + manual trigger modal                     |
| `/commissions`    | Commissions     | super_admin only; versioned config with audit note |
| `/webhook-logs`   | WebhookLogs     | attempts with expandable payload                   |
| `/wallets`        | WalletBalances  | central/gas wallets + per-client pending           |
| `/analytics`      | Analytics       | revenue/commission breakdown charts                |

All BscScan links use `https://bscscan.com/tx/{hash}` and `/address/{addr}`.

## Docker

Multi-stage build (Node build -> nginx serve on port 80, with SPA fallback):

```bash
docker build -t gateway-admin \
  --build-arg VITE_API_BASE_URL=https://gateway.example.com/api/v1 .
docker run -p 8080:80 gateway-admin
```

## API contract

Types in `src/types.ts` and the client in `src/lib/api.ts` mirror
`docs/openapi.yaml`. Admin endpoints consumed:

- `POST /auth/login`
- `GET|POST /admin/clients`, `PUT /admin/clients/{id}` (approve|suspend|regenerate_keys|update)
- `PUT /admin/commission`
- `GET /admin/transactions`
- `GET /admin/payouts`, `POST /admin/payout`
- `GET /admin/webhook-logs`
- `GET /admin/wallets`
- `GET /admin/analytics`

> Note: the OpenAPI file specifies admin request/response bodies loosely. The
> read endpoints for payouts, webhook logs, wallets and analytics are assumed to
> follow the same conventions as the documented admin endpoints; adjust
> `src/lib/api.ts` if the server shapes differ.
