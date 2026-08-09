# Crypto Payment Gateway (USDT / BEP20)

A self-hostable payment gateway for accepting **USDT on Binance Smart Chain
(BEP20)**. Merchants create payments over a signed REST API, customers pay to a
freshly derived deposit address, and the gateway watches the chain, confirms the
deposit, sweeps funds to a central wallet, and settles a net payout to the
merchant — with per-client commissions, webhooks, and an admin/merchant
dashboard.

- **Non-custodial deposit model:** every payment gets a unique HD-derived (BIP-44)
  BEP20 address. Deposit private keys are **never stored** — they're
  reconstructed on demand from the master mnemonic + derivation index.
- **Auth:** merchant API uses `X-Api-Key` + `X-Timestamp` + `X-Signature`
  (HMAC-SHA256); dashboards use JWT with TOTP MFA for admins.
- **Reorg-safe:** confirmations are counted against the chain head with a
  rolling re-scan and a persistent cursor.

---

## Architecture

```
 Merchant server ─(API key + HMAC)─┐
 Customer wallet ─(sends USDT)──────┤
                                    ▼
                          API GATEWAY (Express)
                     auth · hmac · rate-limit · idempotency
                    ┌──────────┬───────────────┬───────────┐
                    ▼          ▼               ▼           ▼
                PostgreSQL   Redis        BullMQ queues  (dashboards)
                    ▲          │               │
          BLOCKCHAIN LISTENER  │            WORKERS
        (WS Transfer + reorg   │      confirm · sweep · payout
         -safe polling cursor) │        webhook · expiry
                    └──────────┴───────► Binance Smart Chain (chainId 56)
                       HD deposit → central wallet → client payout
```

Full diagram, process responsibilities, payment state machine, fund-flow, and
reorg handling: **[docs/architecture.md](./docs/architecture.md)**.

## Monorepo layout

```
crypto-gateway/
├── backend/            # Express API, BullMQ workers, BSC listener (one image, 3 commands)
│   ├── (api)           # node dist/index.js
│   ├── (worker)        # node dist/workers/index.js
│   └── (listener)      # node dist/blockchain/listener.js
├── admin-panel/        # Admin SPA (client onboarding, commissions, monitoring)  :5173
├── client-panel/       # Merchant SPA (API keys, webhook/payout config, payments) :5174
├── sql/
│   └── schema.sql      # PostgreSQL schema (run on first DB init)
├── scripts/            # Ops/seed scripts (e.g. seed-admin)
├── docs/               # Documentation (this folder)
├── docker-compose.yml  # postgres · redis · api · worker · listener · panels
└── .env.example        # Environment contract
```

## Quickstart

```bash
# 1) Configure
cp .env.example .env
# edit .env — set BSC_HTTP_RPC / BSC_WS_RPC, JWT_SECRET, MASTER_ENCRYPTION_KEY,
# HD_WALLET_MNEMONIC, CENTRAL_WALLET_ADDRESS, GAS_STATION_PRIVATE_KEY

# 2) Launch the full stack (schema.sql auto-runs on a fresh Postgres volume)
docker compose up -d --build

# 3) Seed the first admin (see docs/deployment.md §5)
docker compose exec api node dist/scripts/seed-admin.js \
  --email admin@example.com --password '<strong-password>'
```

Then:

Fastest path — starts Docker, applies **every** migration, and boots the API and
both panels in development mode:

```bash
./scripts/dev-up.sh
```

- API: `http://localhost:4000/api/v1`
- Admin panel: `http://localhost:5173`
- Client panel + public site: `http://localhost:5174`

Merchants **register themselves** at `/signup` on the client panel: confirming
the emailed link activates the account (no approval queue), and they then add a
settlement wallet and create an API key from the dashboard. Leave `SMTP_HOST`
empty in development and the confirmation link is printed to the API log instead
of being emailed. Set `SIGNUP_ENABLED=false` to close registration and keep
operator-provisioned accounts (`POST /admin/clients`) as the only way in.

Full walkthrough: **[docs/merchant-onboarding.md](./docs/merchant-onboarding.md)**.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/HANDOFF.md](./docs/HANDOFF.md) | **Start here in a new session** — branch state, what is built, what is not and why, load-bearing invariants |
| [docs/architecture.md](./docs/architecture.md) | System diagram, processes, state machine, fund flow, reorg safety |
| [docs/openapi.yaml](./docs/openapi.yaml) | Full REST API contract |
| [docs/merchant-onboarding.md](./docs/merchant-onboarding.md) | Sign up → verify email → wallet → keys → webhook → first payment → go-live |
| [docs/deployment.md](./docs/deployment.md) | Docker deployment, migrations, BSC RPC, gas station, scaling, TLS, backups |
| [docs/security-checklist.md](./docs/security-checklist.md) | Production security checklist (auth, keys, reorg, ops) |
| [docs/sdk/javascript.md](./docs/sdk/javascript.md) | Node.js SDK + Express webhook receiver |
| [docs/sdk/python.md](./docs/sdk/python.md) | Python SDK + Flask webhook receiver |
| [docs/sdk/php.md](./docs/sdk/php.md) | PHP SDK + plain-PHP webhook receiver |

## Assets and networks

An **asset** is the pair (network, symbol). `USDT-BEP20` and `USDT-TRC20` are
different assets — different contracts, different decimals (18 vs 6) — and
balances never sum across them, exactly as they never sum across chains. A
merchant holding USDC cannot fund a USDT payout with it.

`GET /api/v1/assets` reports what this deployment actually settles; drive coin
pickers from it. Enable more with `ASSETS_BEP20` / `ASSETS_TRC20` (USDT is always
on). Contract addresses and decimals live in
`backend/src/blockchain/assets.ts`, never in env — a wrong value there is a
fund-loss bug, not a config mistake.

TRC20 is off until `TRON_ENABLED=true` **and** a funded Tron hot wallet is
configured; the app refuses to boot half-configured. See
[docs/deployment.md](./docs/deployment.md) § Turning TRC20 on.

## API auth in one paragraph

Merchant endpoints accept two key modes. **HMAC-signed** keys (`pk_live_…`, the
default and the recommended one) send three headers: `X-Api-Key` (your public
key), `X-Timestamp` (unix seconds), and `X-Signature` = hex `HMAC-SHA256` over
the string `"${timestamp}.${rawJsonBody}"` using your API secret (empty body for
GET). Requests with a timestamp skew > 5 minutes are rejected (replay
protection). **Bearer** keys (`ak_live_…`) send the token alone in `X-Api-Key`
with no signing — simpler, but the credential is on the wire every call, so they
are never granted the `payouts:write` scope and should be paired with an IP
allowlist. Presenting either mode with the other's headers is a 401, never a
fallback. No API key of either mode can change your payout wallet, password or
keys — those require a signed-in dashboard session. Webhook payloads carry a
`signature` field = hex `HMAC-SHA256` of the raw body using your per-client
webhook secret — verify it over the raw bytes in constant time. Copy-pasteable
implementations are in the SDK docs.

## Tech stack

- **Backend:** Node.js + TypeScript, Express, BullMQ (Redis-backed queues),
  ethers/web3 for BSC.
- **Datastores:** PostgreSQL 16 (system of record), Redis 7 (cache, locks,
  queues).
- **Blockchain:** Binance Smart Chain (chainId 56), USDT BEP20
  `0x55d398326f99059fF775485246999027B3197955`, HD wallets (BIP-39/BIP-44).
- **Frontends:** Vite SPAs (admin-panel, client-panel).
- **Infra:** Docker Compose (api · worker · listener · postgres · redis ·
  panels); reverse proxy (nginx/Caddy) for TLS.

## Assumptions & production notes

- **USDT has 18 decimals on BSC** (`USDT_DECIMALS=18`) — unlike USDT on Ethereum
  (6). Always handle amounts as **strings / big integers**; never use floats.
- **Non-custodial HD wallets:** deposit addresses are derived from
  `HD_WALLET_MNEMONIC` + a monotonic `derivation_index`. Deposit private keys are
  never persisted — losing the mnemonic loses access to all deposit funds, so
  back it up **cold/offline**.
- **KMS in production:** `MASTER_ENCRYPTION_KEY` (and ideally `JWT_SECRET`) must
  come from a KMS/Vault, not a static `.env` value. Secrets (mnemonic, MFA,
  webhook secrets, hot keys) are envelope-encrypted at rest.
- **Gas is required for sweeps:** BEP20 transfers need BNB. A **gas-station**
  wallet tops up each deposit address just-in-time before sweeping; keep it
  funded and monitored, or sweeps/payouts stall.
- **Confirmations:** deposits are only `confirmed` (safe to fulfill) at
  `REQUIRED_CONFIRMATIONS` (default 12); the listener runs a reorg-safe cursor and
  reverts dropped txs.
- **Single listener instance:** run exactly one `listener` (authoritative
  cursor). `worker` and `api` scale horizontally.
- **This repo ships a reference implementation.** Review the
  [security checklist](./docs/security-checklist.md) and complete a security
  audit before handling real funds.
```
