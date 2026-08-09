# Crypto Payment Gateway — Backend

USDT (BEP20 / BSC) payment gateway backend. Three processes share one codebase:

| Process    | Entrypoint                        | Responsibility |
|------------|-----------------------------------|----------------|
| `api`      | `dist/index.js`                   | REST API (merchants + dashboards) |
| `listener` | `dist/blockchain/listener.js`     | WS `Transfer` subscription + reorg-safe polling reconciler |
| `worker`   | `dist/workers/index.js`           | BullMQ: webhook dispatch, sweep, payout, expiry |

Stack: Node 20, TypeScript (ES2021 / CommonJS), Express, `pg` (raw parameterized
SQL), ioredis, BullMQ, ethers v6, zod, bcryptjs, jsonwebtoken, speakeasy, qrcode,
pino, helmet, express-rate-limit, ulid.

## 1. Install

```bash
cd backend
npm install
```

## 2. Configure

Copy the repo-root env contract and fill it in:

```bash
cp ../.env.example ../.env      # or place .env wherever your process loads it
```

Key notes:
- `MASTER_ENCRYPTION_KEY` must be **64 hex chars (32 bytes)**. In production source
  it from KMS/Vault, not a static env var. It encrypts: HD mnemonic (at use),
  MFA secrets, per-client webhook secrets, and **API secrets** (see below).
- `HD_WALLET_MNEMONIC` + `HD_DERIVATION_PATH` derive deposit addresses. Private
  keys are **never stored** — reconstructed on demand from mnemonic + index.
- `USDT_DECIMALS=18` (USDT on BSC is 18 decimals). All on-chain math is BigInt.
- `GAS_STATION_PRIVATE_KEY` funds deposit addresses with BNB before a sweep and is
  the hot signer for payouts from the central wallet.
- `AUTO_PAYOUT_ENABLED=true` triggers an auto payout after each successful sweep.

## 3. Migrate the database

The schema is the single source of truth:

```bash
psql "$DATABASE_URL" -f ../sql/schema.sql
```

(In `docker-compose.yml` this runs automatically via the postgres init mount.)

## 4. Seed the super admin

```bash
npm run seed                 # admin@example.com / Admin@12345
npm run seed -- 'MyPass123'  # custom password
```

Idempotent — re-running reports "already exists".

## 5. Build & run

```bash
npm run build       # tsc -> dist/

# production
npm start                # API on :4000
npm run start:worker     # BullMQ workers
npm run start:listener   # blockchain listener

# development (tsx watch, no build step)
npm run dev
npm run dev:worker
npm run dev:listener
```

Health check: `GET http://localhost:4000/health`.
API docs (swagger-ui): `GET http://localhost:4000/docs` (served from
`docs/openapi.yaml` when present).

## 6. Authentication schemes

### Merchant API (HMAC)
Headers on every merchant request:
- `X-Api-Key`   — public key id (`pk_live_...`)
- `X-Timestamp` — unix seconds; rejected if skew > 5 min (replay protection)
- `X-Signature` — hex `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`

**API secret storage decision:** the schema fixes `api_keys.api_secret_hash`. HMAC
verification needs the *raw* secret (a bcrypt hash is one-way and unusable for
HMAC). We therefore store the secret **envelope-encrypted** (AES-256-GCM) in that
column rather than bcrypt-hashed, and decrypt it per request to recompute the
signature. The plaintext secret is returned to the merchant exactly **once** at
creation/regeneration. See `src/middleware/auth.ts` for the full rationale.

### Dashboard (JWT)
`POST /api/v1/auth/login` returns `{ accessToken, refreshToken, mfaRequired }`.
Admins with MFA enabled must supply a TOTP `mfaToken`. Role guard via
`requireRole(...)`; `super_admin` passes all checks.

### Webhooks (outbound)
Signature is `HMAC-SHA256(webhook_secret, JSON.stringify(bodyWithoutSignature))`,
hex, included as the `signature` field inside the body and also sent as the
`X-Gateway-Signature` header — symmetric with the inbound merchant scheme.

## 7. Reorg safety (listener)

- Confirmations counted as `head - tx.block_number`.
- A tx is promoted to `confirmed` only at `>= REQUIRED_CONFIRMATIONS`.
- The reconciler re-scans a rolling window `head - REORG_DEPTH`; a previously-seen
  tx absent from the canonical chain is marked `reorged` and its payment reverts.
- All writes are idempotent: `blockchain_transactions` has `UNIQUE(tx_hash,
  log_index)`; status transitions are guarded by `WHERE` clauses.

## 8. Docker

```bash
docker compose up --build       # from repo root; runs api + worker + listener
```

The `backend/Dockerfile` is multi-stage (build → prune → `node:20-alpine` run)
and exposes `4000`.
