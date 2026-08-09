# Deployment Guide

Docker-based deployment for the Crypto Payment Gateway (USDT on BEP20 + optional
TRC20). Covers
prerequisites, environment setup, bringing the stack up, running the schema
migration, seeding the admin, wiring a BSC RPC, funding the gas station,
scaling, health checks, TLS via a reverse proxy, backups, and production
hardening.

Services are defined in [`docker-compose.yml`](../docker-compose.yml):

| Service        | Image / build      | Role                                                        |
|----------------|--------------------|-------------------------------------------------------------|
| `postgres`     | `postgres:16-alpine` | System of record. Auto-runs `sql/schema.sql` on first init. |
| `redis`        | `redis:7-alpine`   | Cache, locks, BullMQ queues (AOF persistence on).           |
| `api`          | `./backend`        | REST API (`:4000`) — merchant + dashboard endpoints.        |
| `worker`       | `./backend`        | BullMQ consumers: confirm-tracker, sweep, payout, webhook.  |
| `listener`     | `./backend`        | Subscribes to USDT `Transfer` logs, reorg-safe cursor.      |
| `admin-panel`  | `./admin-panel`    | Admin SPA (`:5173`).                                         |
| `client-panel` | `./client-panel`   | Merchant SPA (`:5174`).                                      |

---

## 1. Prerequisites

- Docker Engine 24+ and Docker Compose v2 (`docker compose`, not `docker-compose`).
- A domain + DNS records for the API and panels (production).
- A **BSC RPC provider** with both HTTPS and WebSocket endpoints (Alchemy,
  QuickNode, or a self-hosted BSC node).
- A funded **gas-station wallet** (BNB) for sweeps.
- A KMS/Vault for the master encryption key (production).
- `psql` client (for manual migrations / ops), and `openssl` (to generate secrets).

## 2. Environment setup

Copy the contract and fill it in:

```bash
cp .env.example .env
```

Generate strong secrets:

```bash
# JWT secret and 32-byte master encryption key (hex)
openssl rand -hex 48   # -> JWT_SECRET
openssl rand -hex 32   # -> MASTER_ENCRYPTION_KEY  (KMS-managed in prod, see §11)
```

Key variables to set (see `.env.example` for the full list):

- **Core:** `NODE_ENV=production`, `PORT=4000`, `APP_BASE_URL=https://gateway.example.com`.
- **Datastores:** `DATABASE_URL`, `REDIS_URL` (compose defaults point at the
  `postgres`/`redis` services).
- **Auth/crypto:** `JWT_SECRET`, `JWT_EXPIRES_IN=15m`, `JWT_REFRESH_EXPIRES_IN=7d`,
  `MASTER_ENCRYPTION_KEY`.
- **Blockchain:** `BSC_HTTP_RPC`, `BSC_WS_RPC`, `BSC_CHAIN_ID=56`,
  `USDT_CONTRACT=0x55d398326f99059fF775485246999027B3197955`, `USDT_DECIMALS=18`,
  `REQUIRED_CONFIRMATIONS=12`, `PAYMENT_EXPIRY_MINUTES=30`.
- **HD wallet:** `HD_WALLET_MNEMONIC` (encrypted at boot; KMS in prod),
  `HD_DERIVATION_PATH=m/44'/60'/0'/0`.
- **Wallets:** `CENTRAL_WALLET_ADDRESS`, `GAS_STATION_PRIVATE_KEY`.
- **Settlement:** `AUTO_PAYOUT_ENABLED`, `MIN_SWEEP_AMOUNT`, `GAS_TOPUP_BNB`.
- **Webhooks/limits:** `WEBHOOK_MAX_RETRIES`, `WEBHOOK_TIMEOUT_MS`,
  `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`.

> Never commit `.env`. In production, inject secrets from your secret manager
> rather than a file on disk.

## 3. Bring the stack up

```bash
docker compose up -d --build
docker compose ps
```

Compose starts `postgres` and `redis` first (with health checks), then `api`,
`worker`, `listener`, and the two panels wait for their dependencies.

## 4. Run the schema migration

The compose file mounts `sql/schema.sql` into the Postgres init directory
(`/docker-entrypoint-initdb.d/01-schema.sql`), so it runs **automatically on a
fresh volume**. For an existing volume or a manual/repeatable run:

```bash
# From the host, against the running container:
docker compose exec -T postgres \
  psql -U gateway -d gateway < sql/schema.sql

# Or directly with a DATABASE_URL:
psql "$DATABASE_URL" -f sql/schema.sql
```

The schema is idempotent for enums/seed rows (`DO $$ ... EXCEPTION WHEN
duplicate_object`), and seeds the `roles` table (`super_admin`, `ops`,
`merchant`).

## 5. Seed the admin

Create the first `super_admin` user (role seeded by the schema). Use the
project's seed script if present:

```bash
docker compose exec api node dist/scripts/seed-admin.js \
  --email admin@example.com --password '<strong-password>'
```

If no script exists, insert manually (hash the password with the app's hasher —
do **not** store plaintext), then enable MFA on first login. The admin then:

1. Logs into the admin panel (`:5173`) and completes TOTP MFA enrollment.
2. Onboards/approves clients, sets commissions, and monitors transactions.

## 6. Wire a BSC RPC (HTTP + WebSocket)

The `listener` needs a **WebSocket** endpoint to subscribe to USDT `Transfer`
logs; the `api`/`worker` use the **HTTP** endpoint for reads and sending txs.

Examples:

```bash
# Alchemy
BSC_HTTP_RPC=https://bnb-mainnet.g.alchemy.com/v2/<KEY>
BSC_WS_RPC=wss://bnb-mainnet.g.alchemy.com/v2/<KEY>

# QuickNode
BSC_HTTP_RPC=https://<subdomain>.bsc.quiknode.pro/<token>/
BSC_WS_RPC=wss://<subdomain>.bsc.quiknode.pro/<token>/

# Self-hosted BSC node (geth/erigon-bsc)
BSC_HTTP_RPC=http://bsc-node:8545
BSC_WS_RPC=ws://bsc-node:8546
```

- Confirm `BSC_CHAIN_ID=56` (mainnet) and the correct `USDT_CONTRACT`.
- Prefer a provider with generous WS log subscriptions; a dropped WS connection
  should auto-reconnect, and the **polling reconciler** backfills any gap using
  `chain_cursor`.
- For self-hosting, allow time for the node to fully sync before pointing the
  listener at it.

## 7. Fund the gas-station wallet

Sweeps move USDT from HD deposit addresses to the central wallet, but a BEP20
transfer needs **BNB for gas** on the deposit address. The gas station tops up
each address just-in-time (`GAS_TOPUP_BNB`, default `0.0008` BNB).

- Set `GAS_STATION_PRIVATE_KEY` (hot key, worker-only, encrypted at rest).
- Fund the gas-station address with BNB — size it for expected sweep volume
  (e.g. `GAS_TOPUP_BNB × expected daily payments × safety factor`).
- **Monitor its balance** and alert before depletion; a dry gas station stalls
  all sweeps and payouts.
- `MIN_SWEEP_AMOUNT` prevents dust sweeps that cost more gas than they recover.

## 7b. (Optional) Enable TRC20 (Tron) settlement

TRC20 ships **disabled**. A BEP20-only deployment needs none of this. To turn on
Tron settlement:

1. **Apply the migration** (adds per-network columns + a per-network cursor; it is
   idempotent and preserves your existing BEP20 cursor):

   ```bash
   psql "$DATABASE_URL" -f sql/migrations/004_multi_network_trc20.sql
   ```

   On a PM2 deploy this is automatic — `deploy-crypto-gateway.sh` applies every
   `sql/migrations/*.sql` before restarting the processes.

   > **This migration is required by the code, not just by TRC20.** It re-keys
   > `chain_cursor` from `id = 1` to `network`, and the BEP20 listener in this
   > build reads `WHERE network = 'BEP20'`. Deploying the code without the
   > migration breaks BEP20 settlement, whether or not you ever enable Tron.

   To revert later, use `004_multi_network_trc20_rollback.sql` (it refuses to run
   while any TRC20 payment exists, so settle those first).

2. **Provision Tron wallets** (base58 `T…`). Reuse the same HD mnemonic — coin
   type `195'` keeps Tron keys disjoint from BSC's `60'`:
   - `TRON_CENTRAL_WALLET_PRIVATE_KEY` — hot key; swept TRC20 lands in its address
     and TRC20 payouts are signed by it. The app **refuses to boot** with
     `TRON_ENABLED=true` and no key.
   - `TRON_GAS_STATION_PRIVATE_KEY` — optional; funds each deposit address with
     TRX for energy/bandwidth. Falls back to the central key if unset.

3. **Set the RPC + toggle** in `.env`:

   ```bash
   TRON_ENABLED=true
   TRON_FULL_HOST=https://api.trongrid.io
   TRON_API_KEY=<your TronGrid key>        # strongly recommended (rate limits)
   ```

4. **Fund the Tron gas station with TRX.** Unlike BNB gas, a TRC20 transfer from
   an address with no staked energy burns **~13–30 TRX** each. `TRON_GAS_TOPUP_TRX`
   (default `30`) tops up each deposit address just-in-time; `TRON_FEE_LIMIT_TRX`
   (default `100`) caps the burn per transfer. **Stake energy** on the gas-station
   account to cut this cost dramatically at scale.

5. **Restart** so the Tron listener begins polling:

   ```bash
   pm2 restart cg-api cg-worker cg-listener-tron    # PM2 deploy
   docker compose up -d api worker listener-tron    # Docker deploy
   ```

   Merchants set a Tron payout wallet under **Settings → Payout wallet (TRC20)**;
   those without one simply do not receive TRC20 auto-payouts (logged as a skip,
   never a failure). Admins can set it for them on the client detail page.

6. **Watch the TRX balance** in **Admin → Wallet Balances**. It shows central and
   gas positions per chain and raises a warning below 200 TRX. This is the number
   that matters operationally: when the Tron gas wallet empties, every TRC20
   sweep and payout fails until it is topped up.

> **Finality:** Tron blocks *solidify* (become irreversible) after ~19 blocks
> (`TRON_REQUIRED_CONFIRMATIONS`). The Tron listener only records solidified,
> confirmed transfers, so TRC20 deposits need no reorg-revert handling.

> **Never mix addresses across chains.** A BEP20 `0x…` and a TRC20 `T…` address
> are not interchangeable; the gateway validates each on its own network.

### 7c. Verify on the Nile testnet first

Do this before enabling mainnet TRC20 — it proves the signing, energy and sweep
paths with no real funds at risk.

1. Point the gateway at Nile and use the Nile USDT contract:

   ```bash
   TRON_ENABLED=true
   TRON_FULL_HOST=https://nile.trongrid.io
   TRON_USDT_CONTRACT=TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj   # Nile test USDT
   TRON_REQUIRED_CONFIRMATIONS=1                           # faster feedback
   ```

2. Create a Tron wallet, fund it from the Nile faucet
   (<https://nileex.io/join/getJoinPage>), and set it as
   `TRON_CENTRAL_WALLET_PRIVATE_KEY`. Get test USDT from the same faucet.

3. Restart, then run one payment end to end:
   create a payment with `"network": "TRC20"` → send test USDT to the deposit
   address → watch it go `waiting → confirming → confirmed → swept` → confirm the
   payout lands in the merchant's TRC20 wallet.

4. Watch both logs while it runs:

   ```bash
   pm2 logs cg-listener-tron   # deposit detection + promotion
   pm2 logs cg-worker          # sweep, TRX top-up, payout
   ```

5. Revert to the mainnet values above and restart. **Reset
   `TRON_REQUIRED_CONFIRMATIONS` to 19** — 1 is testnet-only.

### 7d. Recovering a stuck TRC20 deposit

If a deposit confirmed but its sweep kept failing (out of energy, RPC outage),
recover it manually. Find the HD index with
`SELECT w.derivation_index, w.network FROM wallets w JOIN payments p ON p.wallet_id = w.id WHERE p.id = '<paymentId>';`
then, from `backend/`:

```bash
./node_modules/.bin/tsx src/recover.ts --network=TRC20 <index>
```

That is read-only — it prints the address, its USDT/TRX balances and the private
key. Add a destination `T…` address to actually sweep the funds out. Index `N` on
BEP20 and index `N` on TRC20 are unrelated addresses, so always pass the
`wallets.network` value you looked up.

## 8. Scaling the listener & workers

- **`worker`** is horizontally scalable (BullMQ distributes jobs via Redis):

  ```bash
  docker compose up -d --scale worker=3
  ```

- **`listener`** (BEP20) and **`listener-tron`** (TRC20) must each run as a
  **single instance** to keep one authoritative, reorg-safe cursor per chain. Do
  **not** scale either > 1 (duplicate processing / cursor races). Rely on
  `restart: unless-stopped` for availability. `listener-tron` idles as a no-op
  while `TRON_ENABLED=false`, so it is harmless to leave declared.
- **`api`** is stateless and scalable behind the reverse proxy:

  ```bash
  docker compose up -d --scale api=3
  ```

- Postgres and Redis: scale vertically first; add read replicas / managed
  services as volume grows.

## 9. Health checks

- `postgres` and `redis` have compose `healthcheck`s (`pg_isready`,
  `redis-cli ping`); dependents wait on `service_healthy`.
- `api` should expose an HTTP health endpoint (e.g. `GET /healthz`) for the
  reverse proxy / orchestrator — checks DB + Redis + RPC reachability.
- `listener` health = WS connected **and** `chain_cursor` advancing; alert if
  `last_scanned_block` stalls relative to chain head.
- `worker` health = queues draining; alert on growing backlog or repeated job
  failures.

## 10. Reverse proxy & TLS

Terminate TLS at a reverse proxy in front of `api` (and, if public, the panels).

### Caddy (automatic HTTPS)

```caddyfile
gateway.example.com {
    reverse_proxy api:4000
}

admin.example.com {
    reverse_proxy admin-panel:80
}

client.example.com {
    reverse_proxy client-panel:80
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name gateway.example.com;

    ssl_certificate     /etc/letsencrypt/live/gateway.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gateway.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=63072000" always;

    location / {
        proxy_pass         http://api:4000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name gateway.example.com;
    return 301 https://$host$request_uri;
}
```

> Configure the API to trust `X-Forwarded-For` **only** from the proxy, so IP
> whitelists and rate limits use the real client IP and can't be spoofed.

## 11. Backups

- **Postgres:** scheduled `pg_dump` (or WAL archiving / PITR for managed
  Postgres). Encrypt dumps and store off-site with retention.

  ```bash
  docker compose exec -T postgres \
    pg_dump -U gateway -d gateway | gzip > backup-$(date +%F).sql.gz
  ```

- **Redis:** AOF is enabled (`--appendonly yes`); snapshot the `redisdata`
  volume. Queues are recoverable, but design workers to be idempotent.
- **HD mnemonic:** back up **offline/cold** (paper/HSM/Shamir). Losing it loses
  access to all deposit-address funds. This is the single most critical backup.
- **Test restores** regularly — an untested backup is not a backup.

## 12. Production hardening

- [ ] Source `MASTER_ENCRYPTION_KEY` (and ideally `JWT_SECRET`) from **KMS/Vault**,
      not the `.env` file.
- [ ] Do **not** expose `postgres:5432` / `redis:6379` publicly — remove the
      host `ports:` mappings in prod; keep them on the internal network.
- [ ] Run only the `api` (and panels) behind the proxy; keep `worker`/`listener`
      off the public internet.
- [ ] Containers as non-root, `restart: unless-stopped`, resource limits set.
- [ ] Pin image tags/digests; rebuild regularly for OS CVE patches.
- [ ] Enable rate limiting, IP whitelisting, and MFA (see
      [security-checklist.md](./security-checklist.md)).
- [ ] Centralized logging + alerting (auth failures, reorgs, gas depletion,
      webhook failure rate, on-chain vs DB balance drift).
- [ ] Single `listener` instance; scale `worker`/`api` horizontally.
- [ ] Keep `REQUIRED_CONFIRMATIONS ≥ 12` and verify `USDT_CONTRACT` /
      `USDT_DECIMALS=18` before taking live traffic.

See [security-checklist.md](./security-checklist.md) for the full checklist.


## Turning TRC20 on

TRC20 is **off by default** and stays invisible in the panels until you enable
it. If `/api/v1/networks` returns only `["BEP20"]`, that is why — it is reporting
reality, not failing.

The single most common cause is that `.env` has **no `TRON_*` lines at all**, so
`TRON_ENABLED` falls back to `false`. Copy the `TRON_*` block from
`.env.example` first.

To enable it you need, in this order:

1. **A funded Tron hot wallet.** Set `TRON_CENTRAL_WALLET_PRIVATE_KEY`. Swept
   TRC20 funds land in this address and payouts are signed from it, so the two
   can never diverge — the address is derived from the key, and a configured
   `TRON_CENTRAL_WALLET_ADDRESS` that disagrees is overridden with a warning.
2. **TRX for energy.** A TRC20 transfer from an address with **no staked energy
   burns roughly 13-30 TRX**. That is per sweep and per payout, so a gas wallet
   with a few TRX in it will stall settlement within a handful of payments.
   Stake energy on the gas station to cut this by an order of magnitude.
   `TRON_GAS_TOPUP_TRX` (default 30) is what each deposit address is given so it
   can pay its own sweep; `TRON_FEE_LIMIT_TRX` is the hard ceiling on the burn.
3. **A TronGrid API key** (`TRON_API_KEY`). Optional, but TronGrid rate-limits
   hard without one, and the listener makes one request per (deposit address,
   asset) per pass.
4. Set `TRON_ENABLED=true` and restart.

The app **refuses to boot** with `TRON_ENABLED=true` and no Tron key. That guard
is deliberate: a half-configured Tron deployment would hand out deposit
addresses it can neither sweep nor settle, stranding customer funds.

Merchants also need a TRC20 payout address (`payout_wallet_trc20`) before they
can be settled on Tron — without one they simply do not get TRC20 payouts, which
is logged as a skip rather than an error.

**Test on Nile first.** Nile TRX is free from a faucet, so the whole money path
can be exercised with no real funds. Point `TRON_FULL_HOST` at
`https://nile.trongrid.io` and set `TRON_USDT_CONTRACT` to Nile's USDT — it is a
different address from mainnet's.

### Accepting more than one token

`ASSETS_BEP20` and `ASSETS_TRC20` are comma-separated symbol allowlists.
USDT is always accepted on an enabled network and does not need listing — an
allowlist typo must not be able to switch off the asset every existing
integration uses.

Contract addresses and decimals are **not** configurable in env. They live in
`backend/src/blockchain/assets.ts` because a wrong contract credits payments
against a token nobody sent, and wrong decimals mis-scale every amount by orders
of magnitude. Neither belongs behind a config toggle.

Adding an asset costs one request per deposit address per pass on Tron
(TronGrid's endpoint filters by a single contract), so keep the TRC20 list short.

