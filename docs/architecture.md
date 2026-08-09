# System Architecture

## 1. High-level diagram

```
                         ┌─────────────────────────────────────────────┐
                         │                 CLIENTS                      │
   Merchant server ──────┤  REST API (API_KEY + HMAC)   Merchant panel  │
   Customer wallet ──────┤  (Trust / MetaMask / Binance) sends USDT     │
                         └───────────────┬─────────────────────────────┘
                                         │
                 ┌───────────────────────▼────────────────────────┐
                 │              API GATEWAY (Express)              │
                 │  auth · hmac · rate-limit · idempotency         │
                 │  /payments /payouts /balance /admin/* /auth/*   │
                 └───┬───────────────┬──────────────────┬─────────┘
                     │               │                  │
          ┌──────────▼───┐   ┌───────▼───────┐   ┌──────▼───────────┐
          │  PostgreSQL  │   │     Redis     │   │  BullMQ queues   │
          │  (system of  │◄──┤ cache + locks ├──►│ webhooks/sweep/  │
          │   record)    │   │               │   │ payout/confirm   │
          └──────▲───────┘   └───────────────┘   └──────┬───────────┘
                 │                                       │
      ┌──────────┴───────────┐                 ┌─────────▼──────────┐
      │  BLOCKCHAIN LISTENER  │                 │      WORKERS       │
      │  ws Transfer events + │                 │  confirm-tracker   │
      │  polling reconciler   │                 │  sweep · payout    │
      │  (reorg-safe cursor)  │                 │  webhook-dispatch  │
      └──────────┬───────────┘                 │  expiry-sweeper     │
                 │                              └─────────┬──────────┘
                 ▼                                        ▼
        ┌────────────────────── Binance Smart Chain (chainId 56) ──────────────────────┐
        │  USDT 0x55d3...7955   HD deposit addrs → central wallet → client payout       │
        └──────────────────────────────────────────────────────────────────────────────┘
```

## 2. Processes (each a Docker service)

| Service     | Responsibility                                                        |
|-------------|-----------------------------------------------------------------------|
| `api`       | REST API for merchants + admin/merchant dashboards                    |
| `listener`  | Subscribes to USDT `Transfer` logs, matches deposit addresses, writes `blockchain_transactions`, advances confirmations, drives a reorg-safe block cursor |
| `worker`    | BullMQ consumers: confirmation tracking, sweeps, payouts, webhook dispatch with retry, payment expiry |

## 3. Payment state machine

```
 waiting ──(tx seen, <N conf)──► confirming ──(≥N conf)──► confirmed ──► swept
    │                                                          │
    └──(expiry timer, no funds)──► expired      (partial pay)──┴──► partial
                                    failed  ◄── (reorg drops tx / underpaid final)
```

## 4. Fund flow & settlement

```
 customer ──USDT──► HD deposit addr ──sweep worker──► central collection wallet
                                                          │
                          commission split (per-client, versioned)
                                                          │
                             ├── client payout  → payout_wallet (net)
                             └── admin commission stays in central wallet
```
- Sweep requires BNB gas on the deposit address → **gas-station** tops it up first.
- Network fee is charged to `client` or `admin` per the client's active commission row.
- Payout may be **auto** (on confirmation) or **manual** (admin trigger).

## 5. Security seams
- API auth: `X-Api-Key` + `X-Signature` (HMAC-SHA256 of timestamp+body) + `X-Timestamp` (replay window).
- Dashboards: JWT access/refresh, TOTP MFA for admins.
- Secrets (mnemonic, mfa_secret, webhook_secret, hot privkeys) envelope-encrypted with `MASTER_ENCRYPTION_KEY` (KMS in prod).
- Deposit private keys are **never persisted** — reconstructed on demand from mnemonic + `derivation_index`.

## 6. Reorg safety
- Confirmations counted as `currentBlock - tx.block_number`.
- A tx is only `confirmed` at ≥ `REQUIRED_CONFIRMATIONS`.
- Polling reconciler re-scans a rolling window behind the head; if a previously-seen tx is absent from the canonical chain it is marked `reorged` and the payment reverts to `confirming`/`waiting`.
