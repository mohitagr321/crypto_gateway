# PayCrypo — production readiness audit

Scope: can this survive **1,000 concurrent requests** and **100,000 coins/day**?

7 domain audits, each finding adversarially verified. **123 confirmed**, 4 refuted.

| severity | count |
|---|---|
| critical | 20 |
| high | 31 |
| medium | 41 |
| low | 31 |


## CRITICAL

### A Redis outage at API start crashes the process outright (unhandled rejection), not just 500s
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/rateLimit.ts:13` — authsec — status: UPGRADED

**Evidence.** The auditor's 500 path is real: rateLimit.ts:13-25 wraps only the synchronous `new RedisStore({...})`, express-rate-limit 7.5.1 (verified installed) has `passOnStoreError: false` (node_modules/express-rate-limit/dist/index.cjs:671) and rethrows the store error (index.cjs:717-727) -> apiError.ts:97-98 -> 500. But it is worse than described. node_modules/rate-limit-redis/dist/index.cjs:95-96 fires TWO async commands in the CONSTRUCTOR and stores the promises as fields: `this.incrementScriptSha = this.loadIncrementScript(); this.getScriptSha = this.loadGetScript();`. `getScriptSha` is only ever awaited by `store.get()`, which the express-rate-limit middleware never calls (it calls only `increment`). db/redis.ts:13-16 sets `maxRetriesPerRequest: 3`, so when Redis is unreachable ioredis flushes those queued commands with MaxRetriesPerRequestError and NOTHING has a handler attached. I ran this against a closed port: the constructor did not throw (so the rateLimit.ts:21 catch and the 'falls back to memory so the API still boots' comment at rateLimit.ts:1-6 never fire), then ~4s later `UNHANDLED REJECTION -> Reached the max retries per request limit (which is 3)` and the process exited. backend/src/index.ts registers NO process-level unhandledRejection/uncaughtException handler — only the three listeners do (evmListener.ts:772, tronListener.ts:551, bitcoinListener.ts:279) — so Node's default terminates the API. rateLimit.ts constructs seven such stores at module load (lines 33, 43, 60, 80, 96, 121, 144). Net effect: if Redis is unreachable when `dist/index.js` starts, the API crashes, PM2 (ecosystem.config.js written by deploy-crypto-gateway.sh) restarts it, and it crashes again — a crash loop for the whole duration of the outage, with /health unreachable rather than merely 500ing. docker-compose.yml:36-38 gates first boot on `redis: {condition: service_healthy}`, but the PM2 production path has no such ordering and a host reboot races.

**Fix.** Three changes, all in backend/src. (1) rateLimit.ts buildStore(): after constructing, defuse the constructor promises — `const s = new RedisStore({...}); void (s as any).incrementScriptSha?.catch(() => {}); void (s as any).getScriptSha?.catch(() => {}); return s;`. This is safe: rate-limit-redis reassigns `this.incrementScriptSha = this.loadIncrementScript(key)` inside retryableIncrement's catch (index.cjs:143-147) and awaits it immediately, so the store self-heals when Redis returns. (2) Add `passOnStoreError: true` to every rateLimit({...}) call (rateLimit.ts:28, 38, 55, 75, 91, 116, 139) so a mid-life store failure fails open with a logged error instead of 500ing — for a payment gateway, briefly unthrottled beats briefly dead. (3) In backend/src/index.ts, register `process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection (api continues)'))` matching evmListener.ts:772, so no future stray promise can take the API down. Also give the shared client in backend/src/db/redis.ts:13 `enableOfflineQueue: false` and `commandTimeout: 1000` so a hung Redis rejects fast instead of holding handlers open, and add a Redis probe to /health (index.ts:60).

### The production deploy script hardcodes the super_admin password, and that account can send funds to an arbitrary address
`/Users/mohit/Desktop/Work/crypto_gateway/deploy-crypto-gateway.sh:41` — authsec — status: UPGRADED

**Evidence.** The seed.ts defaults are as described (seed.ts:16-18 `admin@example.com` / `Admin@12345`, echoed to stdout at seed.ts:51-62, idempotent skip at 31-37). The real deployment is worse and the auditor missed it: deploy-crypto-gateway.sh:41-42 hardcodes `ADMIN_EMAIL="admin@ezulix.com"` and `ADMIN_PASSWORD="ChangeMe@12345"`, passes them to the seed at lines 275-276, and prints them again at line 424. That file is NOT gitignored — .gitignore excludes only deploy_crypto.sh and server-setup.sh — and it names the live hosts (admin-pay.ezulix.com, pay-api.ezulix.com) and the repo (github.com/Ezulix/CryptoPay.git). The path from that credential to funds is direct and I traced it: requireRole short-circuits on super_admin (jwtAuth.ts:67); `PUT /admin/clients/:id` with action='update' is guarded only by requireRole('super_admin','ops') (admin.ts:243-245) and writes `payout_wallet = COALESCE($4, payout_wallet)` (admin.ts:374-390) — i.e. an admin can repoint ANY merchant's settlement address; `POST /admin/payout` (admin.ts:612-614) then settles that merchant's balance to it via requestPayout; and `POST /admin/commission-withdraw` (admin.ts:956-958) takes a caller-supplied `toAddress` (WithdrawSchema, admin.ts:950-955) and broadcasts from the central wallet. authRateLimiter permits max(5, floor(120/12)) = 10 attempts/min per IP (rateLimit.ts:38-40 with RATE_LIMIT_MAX=120 in .env:89) — irrelevant when the password is a literal in a tracked file. This is arbitrary-destination movement of other people's money behind a published string, which is critical by the stated bar, not high.

**Fix.** Immediate: rotate the password on the live admin@ezulix.com account before anything else, and audit `audit_logs` for `payout.*`, `client.update` and any commission withdrawal rows. Then: (1) deploy-crypto-gateway.sh:41-42 — delete both literals; read ADMIN_EMAIL/ADMIN_PASSWORD from the environment or `read -rs` prompt, `die` if empty, and remove the echo at line 424 (print the email only). (2) backend/src/seed.ts:16-18 — remove the `?? 'admin@example.com'` and `?? 'Admin@12345'` fallbacks; exit non-zero when SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD (or argv[2]) are absent, and stop printing the password at line 57. (3) Add `users.must_change_password BOOLEAN NOT NULL DEFAULT false` (new migration), set it true from seed.ts and from the operator-provisioned path at admin.ts:137 (which currently hands out `randomToken(12)`); have POST /auth/login (routes/auth.ts:109) return `{ mustChangePassword: true }` with no accessToken until it is cleared. (4) Add a boot check in backend/src/index.ts start() that refuses to start when NODE_ENV=production and any super_admin row's password_hash verifies against 'Admin@12345' or 'ChangeMe@12345'. (5) Separately, `PUT /admin/clients/:id` action='update' should not be able to change payout_wallet under the 'ops' role — restrict that field to super_admin and require a second confirmation, since it is the single field that converts an admin compromise into merchant fund theft.

### Token reconciler starts at block 1 on every fresh deployment — no detection for ~2 days (and forever on a range-limited RPC)
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmListener.ts:446` — blockchain — status: CONFIRMED

**Evidence.** Read verbatim at evmListener.ts:446 — `const lastScanned = Number(cursorRow?.last_scanned_block ?? 0);` — with NO `|| safeHead - 1` fallback. Twenty lines further down the NATIVE path has exactly that guard: evmListener.ts:543 `const lastScanned = Number(cursorRow?.last_scanned_block ?? 0) || safeHead - 1;` with the comment 'A first run with no cursor must NOT start from block 0'. The seeds are 0: sql/schema.sql:806-815 inserts ('BEP20',0),('TRC20',0),('ERC20',0),('ERC20_NATIVE',0),('BTC',0); sql/migrations/013_erc20_ethereum.sql:72-75 repeats ('ERC20',0),('ERC20_NATIVE',0) — and its own comment at 013:69-71 claims 'Both start at 0 and are initialised to a safe head on first run rather than walking the chain from genesis', which is true only of ERC20_NATIVE. I grepped every .ts and .sql in the repo for `last_scanned_block`: the only writes are evmListener.ts:514 (token), evmListener.ts:565 (native, INSERT..ON CONFLICT), tronListener.ts:535 and bitcoinListener.ts:261 (advisory). Nothing stamps the head at boot; docs/deployment.md:135-141 and 301-302 mention the cursor but never instruct an operator to initialise it. So fromBlock = 1, scanTo = min(safeHead, 2000) (line 456), cursor advances 2000 per 5s pass = 400 blocks/s against BSC's ~1.3-2.2 blocks/s. Real payments at block ~60M are invisible to the reconciler for 60e6/400 ≈ 41.7 h. BSC_WS_RPC is `z.string().optional().default('')` (config/env.ts:68) and evmListener.ts:300-303 explicitly supports it being empty ('using polling reconciler only'), so with WS unset there is no detection at all during that window. Note one correction to the report: the cursor ROW does exist (schema.sql/013 seed it), so the bare UPDATE at line 514 does hit a row — the bug is the value 0, not a missing row.

**Fix.** In backend/src/blockchain/evmListener.ts reconcileOnce(), change line 446 to `const lastScanned = Number(cursorRow?.last_scanned_block ?? 0) || safeHead - 1;` — byte-identical to the native guard at line 543. Change the cursor write at lines 513-516 to the same self-healing upsert used at 565-567: `INSERT INTO chain_cursor (network, last_scanned_block) VALUES ($1,$2) ON CONFLICT (network) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block` (bind cfg.network as $1 rather than interpolating). Then add a migration that changes the seeds in sql/schema.sql:806-815 and sql/migrations/013_erc20_ethereum.sql:72-75 from 0 to NULL and makes the column nullable, so 0 can never again mean 'scanned to genesis'; the `?? 0 || safeHead-1` expression already handles NULL correctly. Finally emit `safeHead - lastScanned` as a gauge on every pass so a cursor that is millions of blocks behind is visible in the first minute rather than after 42 hours.

### BullMQ jobId dedupe makes the settle-tick sweep safety net a permanent no-op, stranding funds at deposit addresses
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/workers/index.ts:211` — blockchain — status: CONFIRMED

**Evidence.** Verified against the installed BullMQ 5.79.2 (backend/node_modules/bullmq/package.json). addStandardJob-9.lua lines 85-92: `jobId = args[2]; jobIdKey = args[1] .. jobId; if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...) end`. I read includes/handleDuplicatedJob.lua in full — it XADDs a 'duplicated' event and `return jobId` without storing the job or pushing it to the wait list. So `add()` is a silent success that queues nothing whenever the hash key still exists. queues.ts:30-31 sets `removeOnComplete: 1000, removeOnFail: 5000` and sweepQueue (queues.ts:42-49) spreads those, so the `sweep-<paymentId>` hash is retained for the last 1000 completions / 5000 failures with no TTL. All four enqueue sites use the same key: evmListener.ts:648-652, tronListener.ts:465-467, bitcoinListener.ts:216-218 and the settle tick at workers/index.ts:211-213. Both dead recovery paths reproduce: (1) gas station dry — evmAdapter.ts:359-366 throws 'sweep requires gas funding but no gas station key configured' (or the gasSigner.sendTransaction throws on insufficient balance), 5 attempts (queues.ts:46) exhaust, job lands in failed and is retained; payment.status stays 'confirmed' so processSettle:203-209 selects it every minute and add() hits the EXISTS branch forever. (2) Ethereum deferral — requiredGasTopup returns null at evmAdapter.ts:169, sweepDeposit returns null at 356, processSweep returns at workers/index.ts:96, the job COMPLETES into the completed set; evmChains.ts:26-27 and evmAdapter.ts:353-356 both promise 'the settle tick re-drives it' and it provably cannot until 1000 further sweeps evict the key.

**Fix.** Stop overloading jobId with two incompatible jobs. Preferred: in backend/src/workers/queues.ts add `export function sweepJobId(paymentId: string, epochMinute = Math.floor(Date.now()/60000)) { return `sweep-${paymentId}-${epochMinute}`; }` and use it at all four enqueue sites (evmListener.ts:648-652, tronListener.ts:465-467, bitcoinListener.ts:216-218, workers/index.ts:211-213). Concurrent enqueues inside one minute still collapse; the next settle tick always mints a fresh job. Then make processSweep itself the real dedupe: at the top of workers/index.ts processSweep, replace the read-only status check at lines 67-70 with a conditional claim — `UPDATE payments SET sweep_claimed_at = now() WHERE id = $1 AND status = 'confirmed' AND (sweep_claimed_at IS NULL OR sweep_claimed_at < now() - interval '10 minutes') RETURNING id` — and return when it yields no row (needs a new `sweep_claimed_at TIMESTAMPTZ` column). Separately, make the ETH deferral visible instead of a success: have evmAdapter.sweepDeposit throw a typed `SweepDeferred` when requiredGasTopup returns null, catch it in processSweep and re-add with `{ delay: 300000 }`, so a deferred sweep sits in the delayed set where an operator can count it.

### A payment is promoted to `confirmed` on ANY nonzero transfer — 0.000001 USDT marks a 500 USDT invoice paid, and permanently jams the settle tick
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmListener.ts:607` — blockchain — status: UPGRADED

**Evidence.** Confirmed verbatim. evmListener.ts:607-617 selects `WHERE p.status='confirming' AND bt.direction='incoming' AND bt.status='pending' AND bt.network='<net>' AND ($1 - bt.block_number) >= p.required_confirmations` — no reference to p.amount or p.amount_received anywhere in the query or the promotion block at 619-656. Identical omission at tronListener.ts:430-440 and bitcoinListener.ts:181-191. recordIncoming flips waiting->confirming on any value (evmListener.ts:256-264); the only value guard in the file is `tx.value <= 0n` on the native path (line 418). invoiceService.ts:694-705 then does `UPDATE invoices i SET status='paid' ... WHERE i.status='open' AND p.status IN ('confirmed','swept')` with no amount comparison at all. I grepped the whole backend for `underpay|tolerance|amount_received >=|amount_received <` — zero hits, so underpayment has no representation anywhere. UPGRADED to critical because there is a second, worse consequence the report missed. After the dust payment reaches 'confirmed', processSweep calls adapter.sweepDeposit, which returns null at evmAdapter.ts:338-344 because the balance is below asset.minSweep (1.0 USDT for BEP20/TRC20 USDT per assets.ts:83,193 and config.settlement.minSweepAmount default '1.0' at config/env.ts:246). processSweep then returns at workers/index.ts:94-97 WITHOUT changing the status, so the payment is stuck in 'confirmed' permanently. processSettle selects `WHERE status='confirmed' ORDER BY confirmed_at ASC NULLS FIRST LIMIT 500` (workers/index.ts:203-209) — these stuck rows have the OLDEST confirmed_at, so once 500 accumulate they occupy the entire batch forever and no genuine confirmed payment is ever re-driven by the safety net again. An attacker can create that state for the price of 500 dust transfers, and it composes directly with sweep-jobid-permanent-noop to strand real customer funds.

**Fix.** Four changes. (1) Add the amount gate to the promotion query in all three listeners — evmListener.ts:607-617, tronListener.ts:430-440, bitcoinListener.ts:181-191 — as `AND p.amount_received >= p.amount * (1 - $tolerance)` with the tolerance a new config value (suggest UNDERPAYMENT_TOLERANCE_BPS, default 0). (2) In backend/src/workers/index.ts processExpiry, add a second statement that writes the dead status: `UPDATE payments SET status = 'partial' WHERE status = 'confirming' AND expires_at < now() - interval '1 hour' AND amount_received > 0 RETURNING id`, emitting a `payment.partial` webhook — this is the terminal state the listeners' `status IN ('waiting','confirming','partial')` predicates have been querying for since day one and nothing has ever written. (3) Add the same guard to services/invoiceService.ts reconcilePaidInvoices (line 694-705): `AND p.amount_received >= p.amount` so an invoice is never marked paid on status alone. (4) Independently of the amount gate, stop the settle-tick jam: in workers/index.ts processSweep, when adapter.sweepDeposit returns null because the balance is below the floor, write a terminal state (`UPDATE payments SET status='partial' WHERE id=$1 AND status='confirmed'`) or add `AND confirmed_at > now() - interval '7 days'` to the processSettle selection at line 203-209 so unswee­pable dust cannot occupy the batch forever.

### Underpayment is promoted to 'confirmed' — the 'partial' status is a dead enum value never written by any code path
`backend/src/blockchain/evmListener.ts:615` — business-logic — status: CONFIRMED

**Evidence.** Re-read all three promotion queries. evmListener.ts:607-617 selects `WHERE p.status = 'confirming' AND bt.direction='incoming' AND bt.status='pending' AND ($1 - bt.block_number) >= p.required_confirmations` — depth only, no reference to p.amount. The UPDATE at :621-627 is `SET status='confirmed', confirmed_at=now() WHERE id=$1 AND status='confirming'`. tronListener.ts:430-439/:443-446 and bitcoinListener.ts:180-190/:193-195 are byte-for-byte the same shape. I enumerated EVERY `UPDATE payments` in the codebase (evmListener 257/595/622/714, tronListener 344/419/444, bitcoinListener 130/170/195, workers/index 120/167) — no statement anywhere writes status='partial' or 'failed'. grep for 'partial' in backend/src returns only read-side `status IN (...)` filters (evmListener 147/190/262, tronListener 140/309/349, bitcoinListener 65/94/135, payoutService 393/476, account.ts 793) plus an analytics counter that can therefore only ever report zero. sql/schema.sql:30 does declare `CREATE TYPE payment_status AS ENUM ('waiting','confirming','confirmed','partial','failed','expired','swept')`. The webhook payload confirms the merchant cannot detect it either: webhookService.ts:131-133 sets `amount: ctx.overrides?.amount ?? (Number(row.amount_received) > 0 ? row.amount_received : row.amount)` and WebhookPayload (:22-30) / canonicalBody (:55-65) carry no expected amount at all. So a 1-of-100 USDT payment emits payment.confirmed with amount '1' and nothing else. No DB constraint, trigger or check mitigates this — payments has no CHECK relating amount_received to amount.

**Fix.** Gate promotion on value, in all three listeners. Add to the `ready` query in evmListener.ts:607-617, tronListener.ts:430-439 and bitcoinListener.ts:180-190: `AND p.amount_received >= p.amount * (1 - $tolerance)` where tolerance is a new env var (PAYMENT_UNDERPAY_TOLERANCE, default 0 — do not invent slack silently). In the same pass add a second query for the complement — `p.status='confirming' AND depth >= required_confirmations AND p.amount_received < p.amount * (1-tolerance)` — and UPDATE those to `status='partial'` guarded by `WHERE id=$1 AND status='confirming'`, then `enqueueWebhook({paymentId, event:'payment.underpaid'})`. Because 'partial' is already in every listener's watch-set filter (evmListener.ts:147, tronListener.ts:140, bitcoinListener.ts:65) and in the payment-match filter (:190/:309/:94), a partial payment keeps being watched and a top-up transfer re-runs RECEIVED_SUM and can carry it over the line — so the promotion query must also match `p.status IN ('confirming','partial')`. Add `amountExpected` to WebhookPayload (webhookService.ts:22-30) and to canonicalBody (:55-65) behind a per-client payload version column, since canonicalBody fixes the signed bytes. Gate invoiceService.ts:703 on the same comparison (see 'underpaid-invoice-marked-paid'). Add a merchant route to accept-as-paid a 'partial', and make processExpiry (workers/index.ts:167) not silently swallow partials — today `WHERE status='waiting'` means a partial never expires at all and sits in the watch set forever.

### A payment that lands after expiry is permanently stranded AND invisible — no transaction row, no unexpected_deposits row, no log line, no webhook
`backend/src/workers/index.ts:167` — business-logic — status: CONFIRMED

**Evidence.** Verified end to end. processExpiry (workers/index.ts:165-172) sets status='expired'. All three watch sets are rebuilt every 30s from `status IN ('waiting','confirming','partial')` ONLY — evmListener.ts:143-149, tronListener.ts:134-150, bitcoinListener.ts:62-68 — so 'expired' drops out. On EVM the address then leaves the RPC filter itself: `const watched = Array.from(depositAddresses)` (:471) feeds `token.filters.Transfer(null, watched)` (:475), so the log is never returned by queryFilter; the WS handler returns at :362 (`if (!depositAddresses.has(to.toLowerCase())) return`) and the native scan at :419. recordUnexpectedDeposit is reachable ONLY from recordIncoming's `if (!payment)` branch (evmListener.ts:197-212, tronListener.ts:316-327), which is itself only entered for addresses already in the watch set — so the LATE PAYMENT case that unexpectedDepositService.ts:24-26 explicitly documents is reachable only inside the <=30s gap before the next refresh. Bitcoin is worse: bitcoinListener.ts:97-103 is `if (!payment) return;` with the comment 'Nothing to record' — no unexpected_deposits row even in-window. I found no reaper: grep for "'expired'" in backend/src returns only workers/index.ts:168/179 and two analytics filters in account.ts — nothing reads on-chain balances for expired payments. Recovery is manual: recover.ts's own header (lines 29-31) says 'The HD index for a payment is wallets.derivation_index (join payments.wallet_id)'. The Bitcoin case makes this routine rather than exceptional: bitcoinListener.ts:242 skips unconfirmed transactions entirely (`if (!tx.status?.confirmed ...) continue`), so a BTC payment stays 'waiting' until its FIRST confirmation. With PAYMENT_EXPIRY_MINUTES=30 (config/env.ts:73) and ~10-minute blocks, any BTC customer who broadcasts in the last ~20 minutes of the window and gets mined after T+30 has their funds silently vanish.

**Fix.** Four parts, in priority order. (a) Stop the expiry from blinding the listener: widen the three refreshDepositAddresses queries (evmListener.ts:145-148, tronListener.ts:137-142, bitcoinListener.ts:63-67) to `status IN ('waiting','confirming','partial') OR (status IN ('expired','confirmed','swept') AND updated_at > now() - interval '7 days')`. This alone converts every late payment into an unexpected_deposits row via the existing !payment branch. (b) Add the missing call at bitcoinListener.ts:103 — replace `if (!payment) return;` with a recordUnexpectedDeposit call using asset BTC and logIndex=vout (the UNIQUE (tx_hash, log_index) on unexpected_deposits, schema.sql:600, already dedupes it). (c) Distinguish the case in the UI/webhook: unexpectedDepositService.ts already stores expected_asset, so `asset = expected_asset` is the late-payment marker — emit a new `payment.late` event so the merchant can honour or refund rather than the money going quiet. (d) Add a reaper on the settle tick: for payments expired in the last N days, read the on-chain balance of the deposit address (adapter.balanceOf is already used by sweepDeposit) and write an unexpected_deposits row for anything non-zero the listener missed. Separately, raise the BTC expiry — a 30-minute window on a 10-minute-block chain that only records confirmed transactions is mis-specified regardless of this bug.

### Settle tick mints a NEW payout row for a payment whose previous payout is `failed`, bypassing the migration-005 double-pay defence
`backend/src/workers/index.ts:238` — concurrency — status: CONFIRMED

**Evidence.** Verified end to end; every link holds.

1. workers/index.ts:238-242 is exactly as quoted: `AND NOT EXISTS (SELECT 1 FROM payouts po WHERE po.payment_id = p.id AND po.status IN ('pending','processing','sent','confirmed'))`. `failed` is not in the list.
2. payoutService.ts:292-296: `catch (err) { const msg = ...; await markFailed(payoutId, msg); throw err; }`. markFailed (payoutService.ts:337-342) is `UPDATE payouts SET status='failed', error=$2 WHERE id=$1` — it does NOT clear `broadcast_at`, so the row keeps its 'a transaction may exist on-chain' flag while the settle tick ignores that flag entirely.
3. The balance guard does not stop it: getBalanceWith (payoutService.ts:481-485) sums payouts `WHERE status IN ('pending','processing','sent','confirmed')`, so a failed P1 frees its gross back into `available`, and requestPayout's check at payoutService.ts:182 passes.
4. No DB backstop exists. schema.sql:637 is `payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL` and the only payouts indexes are schema.sql:663-670 (client, client+network+asset+status, client+network+status, status, network) — none unique on payment_id. I grepped all 21 migrations: no UNIQUE is added to payouts anywhere.
5. P2 is unprotected by construction: nonce/signed_tx/broadcast_at default NULL, so chainBroadcast.ts:85-91 (Tron refuse), :100-107 (re-broadcast stored bytes) and :124-131 (refuse to re-sign) all fall through vacuously and evmAdapter.ts:459-460 fetches a FRESH `getTransactionCount(...,'pending')`.

The Tron case is the sharpest and needs no exotic trigger: chainBroadcast.ts:92-96 calls `markAttempted()` (stamping broadcast_at) then `adapter.sendPayout(...)`. Any throw after the node accepted it leaves P1 failed-with-broadcast_at. BullMQ retries 2..5 (queues.ts:51-58, attempts 5) correctly refuse via :85-91, the job exhausts, and 60s later processSettle mints P2 with broadcast_at NULL — so the 'refuse and escalate' path never runs and a second TRX/TRC20 transfer goes out.

**Fix.** Two changes, both required.

(a) workers/index.ts:238-242 — make the guard match on the on-chain flag, not just the status:
```sql
AND NOT EXISTS (
  SELECT 1 FROM payouts po
   WHERE po.payment_id = p.id
     AND (po.status IN ('pending','processing','sent','confirmed')
          OR po.broadcast_at IS NOT NULL)
)
```

(b) Enforce it at the database, which is the only layer both call sites (processSweep and processSettle) pass through:
```sql
CREATE UNIQUE INDEX CONCURRENTLY idx_payouts_one_auto_per_payment
  ON payouts(payment_id) WHERE type = 'auto' AND payment_id IS NOT NULL;
```
and in requestPayout (payoutService.ts:189-208) catch `err.code === '23505'` on that constraint, `SELECT * FROM payouts WHERE payment_id=$1 AND type='auto'` and return the existing row instead of throwing, so both callers converge.

(c) Add a terminal status that means 'a human must look': extend the `payout_status` enum with `needs_review`, and change markFailed (payoutService.ts:337-342) to
```sql
UPDATE payouts
   SET status = CASE WHEN broadcast_at IS NOT NULL THEN 'needs_review' ELSE 'failed' END,
       error = $2
 WHERE id = $1
```
so `failed` unambiguously means 'nothing reached the wire' and getBalanceWith can keep excluding it safely. Add `needs_review` to the paid-out sum at payoutService.ts:484 so the funds are not released back to the merchant's available balance while the question is open.

### `sweepQueue.add` with a fixed jobId is a permanent no-op once the job exists as completed or failed — the settle tick can never re-drive a sweep that already failed or deferred
`backend/src/workers/index.ts:211` — concurrency — status: CONFIRMED

**Evidence.** Verified against the installed BullMQ (backend/node_modules/bullmq 5.79.2), not from memory.

addStandardJob-9.lua:87-95:
```lua
    jobId = args[2]
    jobIdKey = args[1] .. jobId
    if rcall("EXISTS", jobIdKey) == 1 then
        return handleDuplicatedJob(...)
    end
```
and includes/handleDuplicatedJob.lua ends with `rcall("XADD", eventsKey, ... "event", "duplicated", "jobId", jobId); return jobId .. ""`. It emits an event and returns. It does not re-queue, does not reset state, does not touch the wait list.

Retention: queues.ts:30-31 sets `removeOnComplete: 1000, removeOnFail: 5000`, and includes/removeJobsByMaxCount.lua trims by COUNT (`ZREVRANGE targetSet maxCount -1` then removeJob) — so `sweep-<paymentId>` survives in Redis until 1000 newer sweeps complete (~12h at 2k payments/day) or 5000 newer sweeps FAIL (which on a healthy system is never).

All three enqueue sites use the deterministic id: workers/index.ts:211-213, evmListener.ts:648-652, tronListener.ts:465-467, bitcoinListener.ts:216-218.

This directly falsifies two load-bearing comments: workers/index.ts:197 ('jobId dedupes in-flight sweeps') and evmAdapter.ts:353-356 ('returning null leaves the payment `confirmed` and the settle tick re-enqueues the sweep next minute'). Both terminal states are reachable in ordinary operation: evmAdapter.ts:359-365 throws `sweep requires gas funding but no gas station key configured` when the gas station is dry, and evmAdapter.ts:352-357 returns null on the Ethereum fee-ceiling deferral (a clean COMPLETION, so the key is retained under removeOnComplete).

Amplifier the auditor did not name, which is why I am leaving this critical rather than downgrading to stuck-funds: getBalanceWith (payoutService.ts:468-472) counts `status IN ('confirmed','swept')`, so every permanently-stuck `confirmed` payment still shows as AVAILABLE merchant balance. The merchant can request a manual payout against deposits that were never swept in, draining the central hot wallet against funds the gateway does not hold.

**Fix.** Stop using jobId as both a dedupe key and a retry gate — BullMQ's jobId is a dedupe key with unbounded lifetime, not a lease. Extract one helper and use it at all four enqueue sites (workers/index.ts:210-214, evmListener.ts:648-652, tronListener.ts:465-467, bitcoinListener.ts:216-218):

```ts
export async function enqueueSweep(paymentId: string): Promise<void> {
  const id = `sweep-${paymentId}`;
  const existing = await sweepQueue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'completed' || state === 'failed') {
      await existing.remove();          // terminal: clear the key so add() works
    } else {
      return;                            // waiting/active/delayed: genuinely in flight
    }
  }
  await sweepQueue.add('sweep', { paymentId }, { jobId: id });
}
```
Keeping the jobId preserves in-flight dedupe; removing a TERMINAL job is safe because re-entrancy is already covered by processSweep's own `status !== 'confirmed'` check (workers/index.ts:67-70) and by sweepDeposit reading the live on-chain balance (evmAdapter.ts:333-344).

Also fix the false log at workers/index.ts:261-266: have enqueueSweep return whether it actually created a job and log the true count, so 'settle: re-enqueued sweeps count: N' stops meaning nothing. And add a metric/alert on `SELECT count(*) FROM payments WHERE status='confirmed' AND confirmed_at < now() - interval '15 minutes'` — that number is currently the only externally visible symptom and nothing watches it.

### A Redis outage wedges every listener: BullMQ enqueues park on an unbounded offline queue and never settle, so the `running` guard is never cleared
`backend/src/blockchain/evmListener.ts:643` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Verified end to end in the vendored transports, not just from the call site.

1. The enqueue is awaited inside the promote loop: evmListener.ts:642-646 `try { await enqueueWebhook({ paymentId: p.id, event: 'payment.confirmed' }); }` and :647-655 `try { await sweepQueue.add('sweep', ...) }`. A try/catch cannot catch a pending promise.

2. bullConnectionOptions (db/redis.ts:39-50) sets `maxRetriesPerRequest: null` and does NOT set `enableOfflineQueue`. In ioredis 5.11.1, Redis.js:374-392 `if (!writable) { if (!this.options.enableOfflineQueue) { command.reject(...) } ... this.offlineQueue.push(...) }` — default true, so the command is parked. The only thing that rejects a parked command is `flushQueue`, reached from event_handler.js:198-209 `const { maxRetriesPerRequest } = self.options; if (typeof maxRetriesPerRequest === "number") { ... flushQueue(new MaxRetriesPerRequestError(...)) }`. `typeof null === "object"`, so that branch never runs. The other flush path is `close()`, which event_handler.js:183-186 skips whenever `retryStrategy` is a function — BullMQ installs one by default (redis-connection.js:48-51, `retryStrategy: function (times) { return Math.max(Math.min(Math.exp(times), 20000), 1000); }`). So the command hangs for the whole outage, with no cap on the offline queue.

3. The wedge point is BEFORE detection, not after: reconcileOnce calls `updateConfirmationsAndPromote(head)` at evmListener.ts:449, before detectReorgs (452) and before the queryFilter scan (466-509). So a wedge there stops new-deposit detection too, not just promotion.

4. The guard is only cleared in `.finally()` (evmListener.ts:798-800), so every subsequent 5s tick returns at `if (running) return;` (794) and the pass-complete debug line at :517 is never reached — the process logs literally nothing. Identical shape at tronListener.ts:460/465 with the loop at 566-574, and bitcoinListener.ts:211/216 with the loop at 294-302.

Two corrections to the write-up, neither of which kills it: (a) the wedge is not permanent if Redis returns — the parked commands drain and the pass resumes; (b) during the outage the expiry worker is also down (it is a BullMQ worker), so payments are not expired *during* the incident. The permanent damage lands on recovery: a deposit that arrived while the pass was wedged was never recorded, so its payment is still `waiting`, `expires_at` has passed, the expiry worker (workers/index.ts:165-172, `WHERE status = 'waiting' AND expires_at < now()`) flips it to `expired`, and refreshDepositAddresses (evmListener.ts:143-149, `status IN ('waiting','confirming','partial')`) drops the address from the watch set on its next 30s tick. That deposit is then invisible forever, recoverable only by HD index via recover.ts.

**Fix.** (1) backend/src/db/redis.ts:39-50 — add `enableOfflineQueue: false` to `bullConnectionOptions`. This is the single change that converts the hang into a rejection the existing try/catch at evmListener.ts:644 and :653 already handles correctly (log and continue). Keep `maxRetriesPerRequest: null` — BullMQ requires it for blocking connections and it is not the problem; the offline queue is.
(2) Add `backend/src/utils/withTimeout.ts`: `export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> { let t: NodeJS.Timeout; return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t)); }` and wrap every listener enqueue: evmListener.ts:643 and :648, tronListener.ts:460 and :465, bitcoinListener.ts:211 and :216, at 10_000ms. This makes the pass bounded regardless of what any future transport does.
(3) Watchdog on the `running` guard. In each listener replace the bare `let running = false` with `let running = false; let startedAt = 0;` — set `startedAt = Date.now()` alongside `running = true`, and at the top of the tick add: `if (running) { if (Date.now() - startedAt > 10 * RECONCILE_INTERVAL_MS) { logger.fatal({ stuckMs: Date.now() - startedAt }, 'reconciler pass wedged — exiting for restart'); process.exit(1); } return; }`. Exit rather than force-clear: every write is idempotent and lives in Postgres, and both supervisors (`restart: unless-stopped`, pm2 autorestart) will restart it. Apply at evmListener.ts:792-801, evmListener.ts:813-822 (native loop), tronListener.ts:565-574, bitcoinListener.ts:293-302.

### Unbounded `tx.wait(1)` in the sweep path plus a worker shutdown with no force-exit timer: SIGKILL orphans an on-chain sweep and strands the payment in `confirmed` forever
`backend/src/workers/index.ts:374` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Both halves verified, and the 'nothing ever un-sticks it' claim is stronger than reported.

1. Unbounded waits: ethers 6 declares `wait(_confirms?: number, _timeout?: number)` (node_modules/ethers/lib.commonjs/providers/provider.d.ts:883, impl provider.js:1048) — omitting the second argument waits indefinitely. evmAdapter.ts calls it bare at :244 (native sweep), :379 (gas top-up) and :407 (token sweep). The same file gets it RIGHT at :519, `provider().waitForTransaction(txHash, 1, CONFIRM_TIMEOUT_MS)`, with the constant already declared at :51 and its own comment at :513-517 explaining exactly why an unbounded wait must not pin a worker slot. So this is an inconsistency inside one file, not a design position.

2. Shutdown: workers/index.ts:372-376 is `await Promise.allSettled(workers.map((w) => w.close())); process.exit(0);` with no timer. BullMQ 5.79.2 worker.js:761-784 — `close(force = false)` pushes `() => force || this.whenCurrentJobsFinished(false)` as the first cleanup and awaits it, which waits indefinitely for active jobs. The API has the guard (index.ts:134, `setTimeout(() => process.exit(1), 10_000).unref()`); the worker has none. Sweep concurrency is 3 (workers/index.ts:306).

3. The orphan window is real: evmAdapter.ts:403-406 broadcasts the transfer, then workers/index.ts:101-116 inserts the `blockchain_transactions` row and :119-122 runs `UPDATE payments SET status = 'swept' WHERE id = $1 AND status = 'confirmed'`. A kill between them leaves funds at the central wallet and the ledger at `confirmed`.

4. The retry cannot repair it, and I found a second reason the reporter missed. On re-run, evmAdapter.ts:333 re-reads the on-chain balance, now 0, fails the floor at :338 and returns null; processSweep returns at workers/index.ts:94-97 without touching the status. The settle tick then re-enqueues with `jobId: sweep-${p.id}` (workers/index.ts:211-213) — but BullMQ dedupes on the job KEY, not on job state: scripts/addStandardJob-9.js:520-524, `jobIdKey = args[1] .. jobId; if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...)`. With `removeOnComplete: 1000` / `removeOnFail: 5000` (queues.ts:30-31, 44-48) that key survives for thousands of subsequent jobs, so every settle-tick re-enqueue for that payment is a silent no-op. Confirmed: `config.settlement.autoPayoutEnabled` only fires for `swept` (workers/index.ts:231), so the merchant is never paid.

**Fix.** Four changes, in this order.
(1) backend/src/blockchain/evmAdapter.ts — replace `await tx.wait(1)` with `await tx.wait(1, CONFIRM_TIMEOUT_MS)` at lines 244, 379 and 407. `CONFIRM_TIMEOUT_MS` already exists at :51. Note the semantics: on timeout ethers rejects, the sweep job retries, and step (4) below makes that retry correct.
(2) backend/src/workers/index.ts:372-376 — mirror index.ts:134: `const shutdown = async (signal: string) => { logger.info({ signal }, 'shutting down workers'); const forced = setTimeout(() => { logger.error('worker drain timed out; forcing exit'); process.exit(1); }, 25_000); forced.unref(); await Promise.allSettled(workers.map((w) => w.close())); clearTimeout(forced); process.exit(0); };` 25s sits inside Docker's 30s and pm2's default `kill_timeout`.
(3) Make the sweep write-back crash-safe. In evmAdapter.ts split the token sweep the way chainBroadcast.ts already splits payouts (services/chainBroadcast.ts:16-30 documents the pattern): populate + sign the transfer, hand the caller `{ txHash, signedTx }`, let processSweep INSERT the `blockchain_transactions` row with `status = 'pending'` BEFORE broadcast, then broadcast, then flip to `confirmed`. A re-run then recognises its own transaction.
(4) Un-stick every zombie already in the table — this is the cheapest change and it works even without (3). In backend/src/workers/index.ts, replace the bare `if (!result) return;` at :94-97 with:
```ts
if (!result) {
  const prior = await queryOne<{ tx_hash: string }>(
    `SELECT tx_hash FROM blockchain_transactions
      WHERE payment_id = $1 AND direction = 'sweep' LIMIT 1`, [paymentId]);
  if (prior) {
    await query(`UPDATE payments SET status = 'swept' WHERE id = $1 AND status = 'confirmed'`, [paymentId]);
    logger.warn({ paymentId, txHash: prior.tx_hash }, 'sweep: nothing to move but a prior sweep tx exists; marking swept');
    return;
  }
  return;
}
```
Also stop relying on `jobId` for dedupe across finished jobs: pass `{ jobId: `sweep-${p.id}`, removeOnComplete: true, removeOnFail: 50 }` on the settle-tick add (workers/index.ts:211-213) so the key does not outlive the job.

### Ethereum and Bitcoin can be enabled — minting real deposit addresses — but no process running either listener exists in any deployment artifact
`docker-compose.yml:53` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Checked both deployment paths, not just compose.

docker-compose.yml declares exactly four backend services: `api` (:30, `node dist/index.js`), `worker` (:42, `node dist/workers/index.js`), `listener` (:53, `node dist/blockchain/listener.js` — BSC only, per listener.ts which is `void runEvmListener(BSC)`), and `listener-tron` (:66). No `dist/blockchain/ethListener.js`, no `dist/blockchain/bitcoinListener.js`.

The production path is worse, because it is the one the deploy script writes: deploy-crypto-gateway.sh:300-320 generates `ecosystem.config.js` with exactly four pm2 apps — cg-api, cg-worker, cg-listener, cg-listener-tron. The section header at :297 even says 'Start api + worker + both listeners'. The only place the two missing entrypoints appear anywhere in the repo is backend/package.json:24-27 (`start:listener:eth`, `start:listener:btc`), which nothing invokes.

The gate is open on both chains: networks.ts:265 `if (network === 'ERC20') return config.eth.enabled && Boolean(config.eth.httpRpc);` and :269 `if (network === 'BTC') return config.btc.enabled;`. The comment at :266-269 argues BTC 'needs only the flag: … there is no half-configured state where addresses could be minted but not watched' — the compose file and the pm2 config are precisely that state. adapterFor (:242-254) then succeeds, and createPayment mints and persists a real address at paymentService.ts:239-240 (`getNextDerivationIndex` then `adapter.deriveDeposit(index)`) and writes it at :253. Both listeners idle harmlessly when their chain is off (ethListener.ts:19-27, bitcoinListener.ts:268-272), so there was never a reason to omit them.

**Fix.** (1) docker-compose.yml — add two services alongside `listener-tron` (copy its block verbatim, changing only name and command): `listener-eth: … command: node dist/blockchain/ethListener.js` and `listener-btc: … command: node dist/blockchain/bitcoinListener.js`.
(2) deploy-crypto-gateway.sh:300-320 — add the matching pm2 apps inside the generated `ecosystem.config.js`:
```js
{ name: 'cg-listener-eth', cwd: '${APP_DIR}/backend', script: 'dist/blockchain/ethListener.js',
  instances: 1, env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
{ name: 'cg-listener-btc', cwd: '${APP_DIR}/backend', script: 'dist/blockchain/bitcoinListener.js',
  instances: 1, env: { NODE_ENV: 'production' }, max_memory_restart: '600M' },
```
The script already uses `pm2 startOrRestart` (:327), which starts newly-added apps on redeploy — the comment at :323-326 says exactly that.
(3) Close it at the source so config can never drift again. Have every listener write a heartbeat on each completed pass — reuse `chain_cursor` by adding `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` in a new migration and setting `updated_at = now()` in the existing cursor UPDATEs (evmListener.ts:513-516, tronListener.ts:534-537, bitcoinListener.ts:261-263). Then in networks.ts add an async guard used by createPayment: refuse to mint a deposit address on a network whose `chain_cursor.updated_at` is older than 5 minutes, returning `AppError.badRequest('Network X is temporarily unavailable')`. A chain nobody is watching must reject the payment loudly, not accept the money.

### Tron and Bitcoin poll one HTTP request per watched address per pass, sequentially and with no timeout on the Tron side — pass duration grows linearly with active payments until deposits are missed entirely
`backend/src/blockchain/tronListener.ts:493` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** The shape is exactly as reported, and I found two aggravating factors the write-up missed.

The loop: tronListener.ts:493 `for (const [address, sinceMs] of depositAddresses) {` … :500 `await fetchInboundNative(address, sinceMs)` … :514 `await fetchInboundTransfers(address, sinceMs, asset)` per enabled TRC20 asset … :526 `const blockNumber = await blockNumberOf(t.transaction_id);` per transfer. Every one is a sequential `await`; there is no pool, no batching, no per-pass deadline. bitcoinListener.ts:232-240 is identical: `for (const address of depositAddresses) { txs = await addressTxs(address); }`. `updateConfirmationsAndPromote` — the thing that enqueues the sweep — runs only after the whole loop finishes (tronListener.ts:533, bitcoinListener.ts:260), so promotion degrades in lockstep. The `running` guard (tronListener.ts:566-574, bitcoinListener.ts:294-302) means the 5s / 30s interval stops meaning anything once a pass overruns it.

AGGRAVATOR 1 — Tron's fetches have no timeout at all. tronListener.ts:174 and :204 are bare `await fetch(url, { headers })` with no AbortController. Compare bitcoin.ts:189-196, which does it correctly (`const TIMEOUT_MS = 15_000` + `controller.abort()`). One hung TronGrid socket stalls the entire pass indefinitely — undici's default has no total-request timeout — and the `running` guard then silences the listener permanently, with no log line.

AGGRAVATOR 2 — the 30s refresh timer mutates the Map the pass is iterating. refreshDepositAddresses does `depositAddresses.clear()` then re-`set`s (tronListener.ts:144-149); bitcoinListener.ts:68-69 does the same to its Set. I checked the semantics on Node 24: `const m=new Map([['a',1],['b',2],['c',3]]); for (const [k] of m) { if (…) { m.clear(); m.set('x',1); m.set('y',2); } }` yields `a,b,x,y` — the iterator skips the emptied entries and walks into the newly appended ones. So any pass longer than 30s is repeatedly restarted mid-flight and can be extended without bound.

The arithmetic checks out: `PAYMENT_EXPIRY_MINUTES` defaults to 30 (config/env.ts:73), so the watch set is roughly creation-rate × 30 min. At ~250ms per TronGrid round trip and one TRC20 asset, N=500 is ~4 minutes per pass against POLL_INTERVAL_MS = 5_000 (tronListener.ts:54); N≈9,000 crosses the 30-minute expiry window, at which point the expiry worker flips the payment to `expired` before it is ever polled, refreshDepositAddresses drops it (tronListener.ts:140 filters `status IN ('waiting','confirming','partial')`), and the deposit is never seen.

**Fix.** In backend/src/blockchain/tronListener.ts and backend/src/blockchain/bitcoinListener.ts:
(1) Give the Tron fetches a deadline first — it is two lines and removes the unbounded-stall mode. In tronListener.ts:174 and :204: `const c = new AbortController(); const t = setTimeout(() => c.abort(), 15_000); try { const res = await fetch(url, { headers: …, signal: c.signal }); … } finally { clearTimeout(t); }` — mirroring bitcoin.ts:189-196.
(2) Snapshot the watch set at the top of each pass so the refresh timer cannot mutate it mid-iteration: `const snapshot = Array.from(depositAddresses.entries());` (tronListener.ts:493) and `const snapshot = Array.from(depositAddresses);` (bitcoinListener.ts:232), then iterate the array.
(3) Replace the sequential loop with a bounded-concurrency pool. A minimal version needing no dependency: `const CONCURRENCY = 12; let cursor = 0; await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (cursor < snapshot.length) { const item = snapshot[cursor++]; await scanOne(item); } }));` where `scanOne` is the current loop body. That alone turns 9,000 × 250ms from 37 minutes into ~3 minutes.
(4) Add a per-pass deadline and a resume cursor: track `let resumeIndex = 0` at module scope, start `cursor = resumeIndex`, and when `Date.now() - passStart > POLL_INTERVAL_MS * 6` stop and store `resumeIndex = cursor` so the next pass continues instead of restarting at the head and starving the tail.
(5) Move `updateConfirmationsAndPromote` onto its own `setInterval` with its own guard, independent of the address scan, so confirmations and sweep enqueues keep advancing while a long scan is in flight.
(6) Drop the per-transfer receipt lookup at tronListener.ts:526 by reading the block from the list response where present, as the native path already does (tronListener.ts:215).
(7) Instrument it: log `{ passMs, watching }` on every completed pass and `logger.error` when `passMs > config.paymentExpiryMinutes * 60_000 / 4` — that ratio is the number that predicts stranded deposits.

### Payments are promoted to `confirmed` on confirmation COUNT alone — `amount_received` is never compared to `amount`, and `partial` is never written
`backend/src/blockchain/evmListener.ts:607` — money — status: CONFIRMED

**Evidence.** Re-read the promotion path in all three listeners. evmListener.ts:607-617 selects candidates with only `WHERE p.status = 'confirming' AND bt.direction='incoming' AND bt.status='pending' AND bt.network='...' AND ($1 - bt.block_number) >= p.required_confirmations` — no amount term — then evmListener.ts:621-627 runs `UPDATE payments SET status='confirmed', confirmed_at=now() WHERE id=$1 AND status='confirming'`. tronListener.ts:430-446 and bitcoinListener.ts:181-196 are byte-for-byte the same shape. I grepped the whole tree for `partial`: every hit is a READ (`status IN ('waiting','confirming','partial')` at evmListener.ts:147/190/262, tronListener.ts:140/309/349, bitcoinListener.ts:65/94/135, payoutService.ts:393/476) or a UI constant. There is no `SET status = 'partial'` anywhere, so the enum member declared at sql/schema.sql:30 is unreachable and the merchant analytics count at routes/account.ts:793 is always 0. No CHECK constraint or trigger mitigates it (payments has no amount-related CHECK; sql/schema.sql:310-355). The product explicitly PROMISES the opposite behaviour — client-panel/src/pages/public/Landing.tsx:174 'The payment is marked partial and the amount actually received is recorded', ApiDocs.tsx:440 'partial — Received less than the requested amount.' The webhook payload confirms the consequence: webhookService.ts:131-133 sends `amount: Number(row.amount_received) > 0 ? row.amount_received : row.amount`, so `payment.confirmed` fires carrying the SHORT amount, and any integration keyed on the event name fulfils in full.

**Fix.** Add the amount predicate to the promotion step in SQL so it is atomic with the status change. Export one shared fragment (next to `RECEIVED_SUM` in evmListener.ts:88) so the three listeners cannot drift:

  export const FULLY_PAID = `p.amount_received >= p.amount - (p.amount * $TOL / 10000)`;

(1) In evmListener.ts:607-617, tronListener.ts:430-440 and bitcoinListener.ts:181-192, add `AND p.amount_received >= p.amount` (or the tolerance form) to the `ready` query.
(2) Add a second statement in the same pass that gives short payments a terminal, NON-settling state:
  UPDATE payments SET status='partial', confirmed_at=now()
   WHERE status='confirming' AND amount_received > 0 AND amount_received < amount
     AND id IN (<same confirmation-threshold subquery>);
`partial` is already excluded from the settling sums (payoutService.ts:471) and already included in `pending` (payoutService.ts:476), so no balance code changes.
(3) Add `UNDERPAY_TOLERANCE_BPS` to backend/src/config/env.ts, default 0.
(4) Emit a `payment.partial` webhook alongside, so the merchant is told the order is short instead of told nothing.
(5) MUST ship together with the fix for `no-decimal-validation-against-asset` — adding `amount_received >= amount` while `amount` can carry more decimals than the chain can express turns every over-precise invoice into a permanently stuck payment.

### Payout amounts are handed to the chain adapters as 18-decimal NUMERIC strings — every BTC payout throws unconditionally, and TRC20/ERC20 payouts throw whenever a percentage commission produces >6 fractional digits
`backend/src/services/payoutService.ts:269` — money — status: UPGRADED

**Evidence.** The auditor found the right root cause (nothing normalises money against `asset.decimals`) but described a cosmetic symptom. The live manifestation is a hard, self-perpetuating payout failure.

payoutService.ts:265-273 passes `amountHuman: payout.net_amount` straight from `SELECT * FROM payouts` (payoutService.ts:245-248). `payouts.net_amount` is NUMERIC(38,18) (sql/schema.sql:641), and Postgres renders a NUMERIC at its declared scale — the codebase already knows this: webhookService.ts:129-130 says "NUMERIC comes back as '0.000000000000000000'". So the adapter always receives an 18-fractional-digit string.

BITCOIN — unconditional. chainBroadcast.ts:133 calls `adapter.preparePayout`, and bitcoinAdapter.ts:269 does `const want = btcToSats(amountHuman)` as its FIRST statement. bitcoin.ts:65-68:
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 8) throw new Error(`"${btc}" has more than 8 decimal places (BTC's precision)`);
It tests the STRING LENGTH, not the value. frac is always 18 characters, so 18 > 8 and EVERY BTC payout and EVERY BTC admin withdrawal (adminCommissionService.ts:242 passes `w.amount`, also NUMERIC(38,18)) throws before anything is signed. markFailed sets 'failed', BullMQ burns 5 attempts, and the settle tick (workers/index.ts:238-253, which excludes 'failed') recreates the row every 60s forever. Bitcoin settlement is 100% non-functional.

TRC20/ERC20 (6 dp) — commission-dependent. I verified with the repo's own ethers that parseUnits tolerates trailing zeros ('494.500000000000000000' at 6 dp -> 494500000) but rejects significant digits beyond the format. computeSplit formats at 18 dp via `fromBaseUnits` (commissionService.ts:289-291), so a percentage commission on a 6-dp gross yields 8 dp. Verified numerically: gross '10.123456' at 1.5% -> commission '0.15185184', net '9.97160416'; stored as '9.971604160000000000'; `toTronBaseUnits(amountHuman, 6)` (tron.ts:60-62, called at tronAdapter.ts:354) and `toBaseUnits(amountHuman, asset)` (evmAdapter.ts:468) both throw `too many decimals for format`. Same infinite retry loop. BEP20 USDT is 18 dp, which is why this was never seen.

The creation-side gap the auditor cited is real too — paymentService.ts:174 checks only `Number(input.amount) <= 0`, never `asset.decimals`, and the resolved `asset` is right there at line 189 — and rateService's `QUOTE_DECIMALS = 6` is a hardcoded floor, not derived from the asset.

**Fix.** Three changes, all required.
(1) backend/src/blockchain/bitcoin.ts:65-68 — compare significant digits, not string length:
  const sig = frac.replace(/0+$/, '');
  if (sig.length > 8) throw new Error(`"${btc}" has more than 8 decimal places (BTC's precision)`);
This alone unbreaks Bitcoin settlement.
(2) backend/src/services/payoutService.ts, after `computeSplit` at line 136-140 — quantise the split to the settlement asset before it is persisted, flooring the net so a rounding remainder can never exceed what is held, and absorbing the remainder into commission so gross = commission + fee + net exactly:
  const scale = 10n ** BigInt(ACCOUNTING_DECIMALS - asset.decimals);
  const grossU = toAccountingUnits(input.amount);
  const feeU   = toAccountingUnits(split.networkFee);
  const netU   = (toAccountingUnits(split.netAmount) / scale) * scale;   // floor to asset precision
  const commU  = grossU - feeU - netU;
Insert `fromAccountingUnits(netU)` / `fromAccountingUnits(commU)` at lines 199-201. Assert `commU >= 0n` and throw if not.
(3) backend/src/services/paymentService.ts, after `const asset = parseAsset(...)` at line 189 — normalise the crypto-priced amount: `parseUnits(input.amount, asset.decimals)` inside try/catch, re-emit via `formatUnits`, and throw `AppError.badRequest` naming the asset's precision if the input carried more digits (do NOT silently truncate). Add an upper bound so an oversized amount is a 400 rather than a NUMERIC(38,18) overflow 500. In rateService.ts:101 replace `QUOTE_DECIMALS = 6` with `Math.min(6, asset.decimals)` resolved from the asset being quoted.
Add a regression test that runs a 1.5% commission over a 6-dp gross through requestPayout -> preparePayout on TRC20 and BTC.

### The settle tick's auto-payout omits `asset`, so a USDC/DAI/BNB payment is settled by sending USDT, and the real balance is never consumed
`backend/src/workers/index.ts:246` — money — status: CONFIRMED

**Evidence.** Verified end to end. workers/index.ts:222-243 selects `SELECT p.id, p.client_id, p.amount_received, p.network` — `p.asset` is not in the projection — and workers/index.ts:246-253 calls `requestPayout({clientId, amount, paymentId, network, type, triggeredByUserId})` with no `asset` key. payoutService.ts:86 then does `const asset = parseAsset(network, input.asset)`, and assets.ts:390-395 returns `assetFor(network, defaultAssetFor(network))` for undefined, which assets.ts:259-261 resolves to 'USDT' on BEP20/TRC20/ERC20 (BTC is correctly self-defaulting). The primary path gets it right and says why — workers/index.ts:144-148 passes `asset: sweptAsset` with the comment 'Settle in the asset that actually arrived' — so the defect is confined to the recovery path that only runs after the primary one already failed.

Both losses check out. executePayout threads `asset: payout.asset` into the broadcast (payoutService.ts:270-272), so a row stamped 'USDT' physically sends USDT. And `paidOut` is asset-filtered (payoutService.ts:481-485 with `netFilter` built at 457-460), so the USDC balance is never debited and remains fully withdrawable via `POST /payouts` with `asset: 'USDC'`. The `NOT EXISTS` guard at workers/index.ts:238-242 matches on `payment_id` only, so it accepts the wrong-asset row it just created and stops re-driving — the state stays wrong silently.

The admin path has the identical hole, confirmed: `AdminPayoutSchema` (routes/admin.ts:600-610) has clientId/amount/note/paymentId/estimatedNetworkFee/network and NO asset field, and routes/admin.ts:618-626 passes none. An operator cannot settle a non-USDT balance from the panel at all.

One narrowing the auditor missed: the balance guard at payoutService.ts:182-187 reads the merchant's USDT balance, so the wrong-token send only completes for a merchant who also holds an unpaid USDT balance >= the amount. When they don't, the payment is instead stuck forever logging 'settle: auto payout skipped' (workers/index.ts:254-257). Both outcomes are unacceptable.

**Fix.** (1) backend/src/workers/index.ts:228 — add `p.asset` to the SELECT and to the row type at 222-227; line 246-253 — pass `asset: p.asset`, mirroring line 148.
(2) backend/src/routes/admin.ts:600 — add `asset: z.string().optional()` to AdminPayoutSchema and pass `asset: body.asset` at line 618.
(3) Close the class, not the instance: make `asset` REQUIRED on `RequestPayoutInput` (backend/src/services/payoutService.ts:60) and delete the `parseAsset` undefined-fallback for this call site so the compiler rejects any future caller that forgets it. Same treatment for `SweepResult.asset` (blockchain/networks.ts:77) and `BroadcastRequest.asset` (services/chainBroadcast.ts:71) — every real caller now passes one.
(4) Add a DB backstop in a new migration so a mismatch is impossible even if a predicate is missed:
  ALTER TABLE payouts ADD CONSTRAINT payouts_asset_matches_payment
    CHECK (payment_id IS NULL) NOT VALID;  -- or a trigger comparing payouts.asset to payments.asset
A trigger is the practical form: `RAISE EXCEPTION` when `NEW.payment_id IS NOT NULL AND NEW.asset <> (SELECT asset FROM payments WHERE id = NEW.payment_id)`.

### A payout marked `failed` after its transaction reached the wire releases the reserved balance, and the settle tick creates a SECOND payout for the same funds
`backend/src/services/payoutService.ts:337` — money — status: CONFIRMED

**Evidence.** Every link verified. markFailed (payoutService.ts:337-342) sets `status='failed'` on ANY throw from broadcastTransferOnce, including one raised after `persistPrepared` committed the signed bytes and the node accepted the transaction (chainBroadcast.ts:142-145: `await req.persistPrepared(prepared); const sent = await adapter.broadcastPayout!(prepared.signedTx);`). The comment at payoutService.ts:478-480 claims the mitigation is that 'executePayout refuses to blind-retry those' — but payoutService.ts:253-256 skips only `status === 'sent' || 'confirmed'`, never 'failed'. More importantly the protection is per-ROW and nothing protects against a NEW row: `paidOut` excludes 'failed' (payoutService.ts:481-485) and the settle tick's guard excludes it too (workers/index.ts:238-242: `po.status IN ('pending','processing','sent','confirmed')`). I checked sql/schema.sql:634-671 and every migration — there is NO unique index on payouts(payment_id); migration 005 added only nonce/signed_tx/broadcast_at and two btree indexes.

So: P1 broadcasts, socket resets, markFailed fires, the 500 drops out of `paidOut`, the settle tick (60s, queues.ts:108-119, unsynchronised with BullMQ's 15s/30s/60s/120s backoff — 225s of attempts spanning four ticks) sees `swept` with no non-failed payout and calls requestPayout again. P2 gets a fresh nonce from `nonce ?? await rpc.getTransactionCount(signer.address,'pending')` (evmAdapter.ts:459-460) — 42, not P1's 41 — signs, and both land. `availU` then goes negative and is clamped to 0 at payoutService.ts:487-489, hiding the overdraft.

One narrowing and one WIDENING the auditor missed. Narrowing: evmAdapter.ts:497-508 catches 'already known'/'nonce too low'/'duplicate' and treats them as sent, so the surviving window is a transport error after node acceptance. WIDENING, and worse: on Tron the whole 'refuse to re-send' escalation at chainBroadcast.ts:84-91 is keyed on `state.broadcastAt` of THAT ROW. A brand-new row P2 has broadcastAt NULL, so the settle tick walks straight past the guard the file was written to enforce and sends a second TRX/TRC20 transfer with no nonce protection at all.

**Fix.** (1) Add `'unresolved'` to the `payout_status` enum in a new migration. Change markFailed (backend/src/services/payoutService.ts:337) to take the row and branch: `SET status = CASE WHEN broadcast_at IS NOT NULL THEN 'unresolved' ELSE 'failed' END`. Only a payout that never reached the wire may release its reservation.
(2) Include the new state in BOTH reservation predicates: payoutService.ts:484 -> `status IN ('pending','processing','sent','confirmed','unresolved')`, and workers/index.ts:241 likewise. Also add it to `getAllBalances` (payoutService.ts:398).
(3) Backstop it in the database so no missed predicate can ever produce a second row, in a new migration:
  CREATE UNIQUE INDEX uq_payouts_active_payment ON payouts(payment_id)
    WHERE payment_id IS NOT NULL AND status <> 'failed';
This is the same belt-and-braces the subscription path already relies on (uq_invoices_subscription_cycle, sql/schema.sql:443). Note the settle tick must then tolerate a 23505 on insert as a no-op.
(4) Surface `unresolved` in the admin panel as a human-action queue: check the explorer, then promote to 'sent' or release to 'failed'. Change workers/index.ts:153-158 and 254-257 from logger.warn to logger.error so a merchant who is never being paid is visible.

### Commission is defined in USDT but applied in the payment's asset — a `fixed` commission or a fixed tier takes 100% of every BTC/BNB/ETH payment and the merchant is never paid
`backend/src/services/commissionService.ts:242` — money — status: CONFIRMED

**Evidence.** Verified. `applyRate` (commissionService.ts:242-248) returns `toBaseUnits(value)` verbatim for `type==='fixed'`, and `pickTier` (commissionService.ts:129-136) compares `grossU` against `toBaseUnits(t.minAmount)`/`toBaseUnits(t.maxAmount)` — both treat the number as USDT. The schema says so: `value NUMERIC(38,18) NOT NULL, -- percent (e.g. 1.5) or fixed USDT` (sql/schema.sql:619) and the interface comment `value: string; // fixed USDT fee` (commissionService.ts:36). But `computeSplit(gross, commission, networkFee)` (commissionService.ts:262-266) takes NO asset, and I confirmed the `commissions` table (sql/schema.sql:615-630) has no asset or network column — checked every migration, none adds one. payoutService.ts:136-140 calls it with `input.amount`, documented at payoutService.ts:57 as 'gross amount to settle, in `asset`'. So there is no way for an operator to express a per-asset fixed fee at all.

The arithmetic checks out. A 0.04998 BTC gross with the file's OWN documented example slabs (commissionService.ts:14-17: 0-10 -> fixed 1 USDT) resolves grossU=0.04998e18 into the first slab (minU=0, maxU=10e18), applyRate returns 1e18 = one whole Bitcoin, and the clamp at commissionService.ts:279 (`if (commissionU > grossU) commissionU = grossU`) silently converts a config error into a 100% fee. `requestPayout` then throws at payoutService.ts:143-147 ('Net payout is zero after commission'), workers/index.ts:153-158 logs it at WARN, and the settle tick repeats the identical computation every 60s forever. Identical for BNB (minSweep 0.002, assets.ts:229) and ETH (minSweep 0.005, assets.ts:160).

Misattribution confirmed: the BTC is already in the central wallet as a `direction='sweep'` row (workers/index.ts:101-116), so adminCommissionService.ts:79-84 counts it in `collected` with no offsetting `clientOwed` (adminCommissionService.ts:85-90 sums payouts, and none exists). It becomes withdrawable operator commission.

Scope correction to the auditor: PERCENTAGE commissions are asset-agnostic and compute correctly on any asset. The defect is (a) `fixed` and fixed tiers, and (b) tier BOUNDS, which mis-slab even a purely percentage tier set (a 0.05 BTC payment worth $5,000 lands in the '0-10, small payment' slab).

**Fix.** (1) Immediate, ship first — replace the silent clamp with a loud failure. backend/src/services/commissionService.ts:279:
  if (commissionU > grossU) throw AppError.badRequest(`commission ${fromBaseUnits(commissionU)} exceeds gross ${gross}; the commission is configured in a different denomination than the settlement asset`);
A thrown payout is recoverable; a 100% fee that reads as legitimate commission is not.
(2) Give commissions an asset dimension. New migration: `ALTER TABLE commissions ADD COLUMN asset TEXT, ADD COLUMN network TEXT;` (nullable for back-compat = 'applies to the chain default'). Change `getActiveCommission(clientId)` (commissionService.ts:51) to `getActiveCommission(clientId, network, asset)` and pick the most specific active row: exact (network, asset), then network-only, then client-wide. Index: `CREATE INDEX idx_commissions_client_scope ON commissions(client_id, network, asset) WHERE is_active;`
(3) Make the denomination explicit in the arithmetic: add `asset: Asset` to `computeSplit` (commissionService.ts:262) and have `applyRate` reject a `fixed` rate whose configured asset differs from the settlement asset rather than reinterpreting the number. Thread the asset from payoutService.ts:136.
(4) Update the admin CommissionEditor (admin-panel/src/components/CommissionEditor.tsx) to require an asset for fixed/tiered-fixed rates, and validate at set time (commissionService.ts:153) rather than at payout time.
(5) Change workers/index.ts:153-158 to logger.error and persist a `payouts` row in a blocked state so an unpayable merchant is visible in the panel rather than only in a log line.

### Admin commission balance sums every asset on a chain into one number labelled USDT, and the withdrawal always sends USDT
`backend/src/services/adminCommissionService.ts:79` — money — status: CONFIRMED

**Evidence.** All four claims verified. adminCommissionService.ts:79-96: `collected` = `SUM(amount) FROM blockchain_transactions WHERE direction='sweep' AND status='confirmed' AND network=$1`; `clientOwed` = `SUM(net_amount) FROM payouts WHERE status IN (...) AND network=$1`; `withdrawn` = `SUM(amount) FROM admin_withdrawals WHERE status IN (...) AND network=$1`. Not one filters on asset. Line 111 returns a hardcoded `currency: 'USDT'`, and the interface types it as the literal `'USDT'` (line 39).

The underlying tables all HAVE the column: blockchain_transactions.asset is populated by the sweep writer (workers/index.ts:101-116, `$6 = sweptAsset` written to both `token` and `asset`); payouts.asset exists with a covering index (sql/schema.sql:644, 664-665); admin_withdrawals.asset exists as `asset TEXT NOT NULL DEFAULT 'USDT'` (sql/schema.sql:691, added by migration 008_multi_asset.sql:36) and requestAdminWithdrawal NEVER sets it — the INSERT at adminCommissionService.ts:176-181 lists only amount/to_address/network/status/triggered_by, so every row silently defaults to USDT.

The send side matches: adminCommissionService.ts:238-249 calls broadcastTransferOnce with no `asset` field, chainBroadcast.ts:78 reads `const asset = req.asset` (undefined) and passes it through, and evmAdapter.ts:453 `chainAsset(undefined)` falls back to the chain default = USDT on BEP20 (assets.ts:259-261). Contrast payoutService.ts:270-272, which does thread `asset: payout.asset` and explains why. The file's own header (lines 9-15) argues at length that pooling across NETWORKS is a correctness bug; the identical argument one level down to assets was not carried through.

Direction of error confirmed: any non-USDT accrual (sweep minus payout net, in that asset's units, or the FULL sweep when no payout row exists — which per `commission-denominated-in-payment-asset` is the normal state for natives) is added to a pool that is then spent as USDT. Merchant USDT deposits fund it. payoutService.ts:468-487 reads only payments/payouts and is untouched by admin_withdrawals, so merchant `/balance` keeps showing the money as available until a payout reverts for insufficient funds. There is no reconciliation job anywhere — getCommissionBalance is the only definition of the pool.

**Fix.** (1) backend/src/services/adminCommissionService.ts:76 — change the signature to `getCommissionBalance(network: Network, asset: string)`, add `AND asset = $2` to all three queries (lines 82, 88, 94), and return `currency: asset` at line 111 (widen the `CommissionBalance.currency` type at line 39 from the `'USDT'` literal to `string`).
(2) Line 116 — `getAllCommissionBalances()` iterates `enabledAssets()` (blockchain/assets.ts) instead of `enabledNetworks()`, returning one row per (network, asset).
(3) Line 120 — add `asset?: string` to `RequestAdminWithdrawalInput`; resolve `const asset = parseAsset(network, input.asset)` after line 142; write `asset.symbol` into the INSERT at line 177; guard against `getCommissionBalance(network, asset.symbol)` at line 169; and thread `asset: w.asset` into broadcastTransferOnce at line 238, exactly as payoutService.ts:272 does.
(4) backend/src/routes/admin.ts — add `asset: z.string().optional()` to the admin withdrawal request schema and pass it through. Update admin-panel to show one balance card per (network, asset).
(5) New migration — the aggregate at line 80-84 currently scans the whole table on every admin dashboard load and `idx_btx_network_asset` does not cover the predicate:
  CREATE INDEX idx_btx_sweep_network_asset ON blockchain_transactions(network, asset)
    WHERE direction='sweep' AND status='confirmed';
(6) Add a reconciliation job that compares, per (network, asset), on-chain central-wallet balance against `collected - clientOwed - withdrawn` and alerts on divergence. Nothing today would ever catch this drift.

### Tron and Bitcoin listeners make one sequential HTTP call per watched address per pass — the pass can never finish at volume
`backend/src/blockchain/tronListener.ts:493` — scale-and-load — status: CONFIRMED

**Evidence.** tronListener.ts:493 `for (const [address, sinceMs] of depositAddresses)` with a nested `for (const asset of trcAssets)` at :511, awaiting `fetchInboundTransfers(address, sinceMs, asset)` at :514 and then `await blockNumberOf(t.transaction_id)` per discovered transfer at :526. Serial awaits, no batching, no concurrency pool. Timer is POLL_INTERVAL_MS = 5_000 (tronListener.ts:53). bitcoinListener.ts:232-240 is identical in shape (`for (const address of depositAddresses) { txs = await addressTxs(address) }`) on a 30 s timer (bitcoinListener.ts:55). The watch set is unbounded: tronListener.ts:137-143 and bitcoinListener.ts:62-67 both `SELECT ... FROM payments WHERE status IN ('waiting','confirming','partial')` with no LIMIT. The comment at tronListener.ts:485-488 admits the shape. Per-address failure only `continue`s (tronListener.ts:517-521, bitcoinListener.ts:237-240), so a throttled address is silently skipped for the whole pass, and TRON_API_KEY defaults to '' (config/env.ts:120).

The arithmetic is worse than the finding claims, which is why critical stands. It does not need thousands of addresses: PAYMENT_EXPIRY_MINUTES=30 (config/env.ts:73) means the watch set is arrival-rate x 30 min, so just ~20 in-flight TRC20 addresses across 3 assets is 60 sequential TronGrid calls; at 150 ms each that is 9 s against a 5 s timer. The `running` guard at tronListener.ts:566-573 turns that into continuous back-to-back passes over a stale set, and updateConfirmationsAndPromote (tronListener.ts:533) — the only thing that promotes payments and enqueues sweeps on Tron — runs only at the END of a pass. So confirmations and sweeps stall behind the whole address walk, customer funds sit at HD deposit addresses, and merchants are never credited. Scoped: TRON_ENABLED and BTC_ENABLED both default false (config/env.ts:117, 134), so this bites only deployments that turned those chains on.

**Fix.** Two changes, both needed. (1) Decouple promotion from discovery: move `updateConfirmationsAndPromote(nowBlock)` (tronListener.ts:533, bitcoinListener.ts:260) onto its own setInterval with its own `running` guard, so confirmations and sweep enqueues keep advancing at a fixed cadence no matter how long the address walk takes. This is the change that stops funds sitting uncredited and can ship today. (2) Stop the O(addresses) walk: for Tron, poll the token contract's own feed once per pass — `GET /v1/contracts/{contract}/events?event_name=Transfer&min_block_timestamp={cursor}` — persist the timestamp cursor in chain_cursor and match `to` against the in-memory Set, the same shape evmListener.ts:466-509 uses. Where a per-address query is unavoidable (Bitcoin/Esplora), run it through a bounded concurrency pool of 8-16 with a token-bucket limiter sized to the provider quota instead of `await` in a for-loop, and process the watch set as a rolling window with a persisted position so no address is starved. Also cap the watch set: add `AND expires_at > now() - interval '1 hour'` to refreshDepositAddresses in both files so a stalled expiry worker cannot grow it without bound.


## HIGH

### Merchant-controlled webhook_url is a read-SSRF with response exfiltration back to the merchant
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/services/webhookService.ts:201` — authsec — status: DOWNGRADED

**Evidence.** Every mechanical claim checks out. `webhookUrl: z.string().url().nullable().optional()` at routes/account.ts:321 and `webhookUrl: z.string().url().optional()` at routes/admin.ts:121; grepping backend/src for 169.254 / isPrivate / urlGuard / assertPublic / any host or scheme allowlist returns nothing. webhookService.ts:201-210 calls `fetch(log.url, { method: 'POST', ... })` with no `redirect` option (undici default is 'follow'), and a 301/302 on a POST is downgraded to GET by the fetch spec — so a merchant registering an https public host and answering 302 reaches GET-only internal endpoints. webhookService.ts:212 `responseBody = (await res.text()).slice(0, 4000)`, persisted at 228-234 (attempt 1) and 237-245 (each retry inserts a NEW row, WEBHOOK_MAX_RETRIES defaults to 8 at config/env.ts:257). routes/account.ts:947-948 selects response_body and 966 returns `responseBody: r.response_body`; that route (account.ts:929-932) is guarded by `clientAuth` with NO requireScope at all, so any key of either mode reads it. sql/schema.sql:718 confirms the column. Blast radius for THIS deployment is concrete: deploy-crypto-gateway.sh runs the worker under PM2 on a box explicitly co-hosting another production app ('Zaplo keeps 4000', API on 4100, Apache on 80/443), all reachable at 127.0.0.1 with up to 4000 chars of each response handed back to the attacker. Why not critical: there is no path from this primitive to moving funds — every money-moving endpoint requires a credential the SSRF cannot obtain, and the IAM-credential claim is environment-specific (AWS IMDSv2 needs a PUT-issued token, GCP requires a Metadata-Flavor header, and this target is a VPS, not necessarily a cloud instance with IMDSv1).

**Fix.** New file backend/src/utils/urlGuard.ts exporting `assertPublicHttpUrl(raw: string): Promise<void>`: parse with `new URL`, require protocol http:/https:, reject any hostname that `dns.promises.lookup(host, { all: true })` resolves into 127.0.0.0/8, ::1, 169.254.0.0/16, fe80::/10, 10/8, 172.16/12, 192.168/16, fc00::/7, 100.64.0.0/10 or 0.0.0.0/8 (use `net.BlockList` with addSubnet). Call it (a) in the zod schemas at routes/account.ts:321 and routes/admin.ts:121 via `.refine`, (b) again inside dispatch at webhookService.ts:200 before the fetch, because rows predating the validator are already in the table, and (c) against the resolved IP at fetch time, not the literal string, so DNS rebinding does not slip through. Pass `redirect: 'manual'` to the fetch at webhookService.ts:201 and treat any 3xx as a delivery failure — a redirect is never a valid webhook ack. Stop persisting the target's body: at webhookService.ts:212 replace the 4000-char capture with `responseBody = res.ok ? '' : sha256Hex(await res.text()).slice(0,16)`, or at minimum drop response_body from the projection at routes/account.ts:947 and 966 so the SSRF is blind (keep it in the admin-only view at admin.ts:658). Finally add `requireScope(SCOPES.paymentsRead)` to GET /account/webhook-logs, which today has no scope guard at all, and give the worker an egress policy so this is not the only layer.

### HMAC signatures bind neither method nor path and have no nonce — a captured signature is reusable for 5 minutes on a different endpoint
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/auth.ts:223` — authsec — status: DOWNGRADED

**Evidence.** The scheme is exactly as described: middleware/auth.ts:223 `hmacSha256(secret, `${timestamp}.${rawBody}`)`, with the only control being the 300s skew check at auth.ts:199-206; there is no nonce set, no seen-signature table, nothing in Redis (grepped). docs/sdk/javascript.md:21 makes the cross-endpoint attack concrete in the vendor's own words: 'For requests with no body (GET), the raw body is the empty string, so you sign "${timestamp}."'. So a signature lifted from a routine `GET /api/v1/payments` poll is byte-identical to a valid signature for any other empty-body request at that second, and three such endpoints exist that read no body and are gated only by requireScope(paymentsWrite): POST /invoices/:id/void (invoices.ts:145-151), POST /payment-links/:id/{disable,enable} (paymentLinks.ts:117-139), POST /subscriptions/:id/{pause,resume,cancel} (subscriptions.ts:120-127). POST /payouts (payouts.ts:86-91) indeed carries no idempotency middleware — it is mounted only on POST /payments (payments.ts:50) and is opt-in there (idempotency.ts:27-31). BUT the auditor's headline consequence is wrong and that is why this is high, not critical: payoutService.ts:110-119 resolves the destination from the CLIENT's stored payout_wallet columns, never from the request, and PUT /account/settings is behind requireDashboardSession (account.ts:343-347), so an HMAC key cannot repoint it — a replayed payout sends the merchant's own money to the merchant's own address. payoutService.ts:149-186 (pg_advisory_xact_lock + balance read inside the lock) caps the total at the available balance. So the damage is forced early settlement, duplicated commission and gas, plus sabotage of invoices/links/subscriptions — not theft. Confirmed separately: idempotency.ts is check-then-act (GET at line 37, `SET ... NX` at 56-58 only after the handler runs), so two concurrent POST /payments with the same Idempotency-Key both miss and both create a payment.

**Fix.** backend/src/middleware/auth.ts:223 — change the signed string to `${timestamp}.${req.method.toUpperCase()}.${req.originalUrl}.${sha256Hex(rawBody)}` and ship it as signature v2: add an `api_keys.signature_version SMALLINT NOT NULL DEFAULT 1` column (new migration), verify v1 or v2 per key during a deprecation window, and update docs/sdk/{javascript,php,python}.md and docs/openapi.yaml together — the SDK snippets at docs/sdk/javascript.md:89-93 are the normative definition. Add a replay cache immediately after safeEqual succeeds (auth.ts:225): `const ok = await redis.set(`nonce:${row.api_key_id}:${signature.toLowerCase()}`, '1', 'EX', 660, 'NX'); if (!ok) throw AppError.unauthorized('Signature already used');` — 660s covers the ±300s window on both sides; wrap in try/catch and fail open on a Redis error so it cannot recreate the outage above. In backend/src/routes/payouts.ts:86, mount the existing `idempotency` middleware after requireScope and make Idempotency-Key mandatory (400 when absent) — a money-out endpoint must not be silently non-idempotent. And fix middleware/idempotency.ts: replace the read at line 37 with an atomic reservation `SET key '{"status":"in_progress"}' EX 60 NX`; if it returns null, read the stored value and either replay the cached response or 409 'Request with this Idempotency-Key is still in flight'; overwrite with the real response in the res.json wrapper (drop the NX at line 57, it now conflicts with the reservation).

### Refresh tokens are unrevocable and re-mint their own claims — a suspended or demoted admin keeps super_admin indefinitely
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/routes/auth.ts:134` — authsec — status: CONFIRMED

**Evidence.** routes/auth.ts:121-141 verified line by line: verifyToken, a `payload.type !== 'refresh'` check, then `const claims = { sub: payload.sub, role: payload.role, email: payload.email }` built entirely from the token (line 134) and BOTH a new access token and a new 7-day refresh token minted (lines 136-137). No SELECT against users, no status check, no rate limiter — contrast /login at auth.ts:44 which has authRateLimiter and does check `user.status !== 'active'` (auth.ts:60). middleware/jwtAuth.ts:31-33 is `jwt.verify(token, config.jwt.secret)` with no DB read, and jwtAuth.ts:51 trusts `decoded.role` wholesale; grepping the backend for jti / blacklist / denylist / token_version returns nothing. Neither routes/account.ts:463-467 (change-password) nor routes/register.ts:421-431 (reset-password) touches JWTs — register.ts:455-459 clears user_tokens only. One sharpening the auditor missed, which makes it worse: there is NO route anywhere that sets users.status away from 'active' (the only `UPDATE users` statements in the tree are account.ts:465, auth.ts:96, admin.ts:306, admin.ts:362, register.ts:423 and register.ts:431 — password, email, last_login, email_verified), so suspending an admin is necessarily a manual DB edit, and /auth/refresh ignores the DB entirely, so that manual edit has precisely zero effect on any live session. Partial mitigation on the merchant side only: clientAuth.ts:58-68 re-reads the clients row on every request and requireApprovedClient (clientAuth.ts:89-103) rejects a non-approved client, so suspending a CLIENT does take effect on merchant routes. The admin surface has no equivalent.

**Fix.** routes/auth.ts:121-141 — inside /refresh, re-read the user (`SELECT u.id, u.email, r.name AS role_name, u.status FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`), 401 unless `status = 'active'`, and build `claims` from those columns rather than from the token; add `authRateLimiter` to the route (it is already imported at auth.ts:19). Add `users.token_version INT NOT NULL DEFAULT 0` (new migration); include it in the payload at middleware/jwtAuth.ts:19-29 and reject in verifyToken/jwtAuth when it differs from the DB value; bump it in account.ts:464 (change-password), register.ts:423 (reset-password), admin.ts:306 (admin set_password) — that gives one-line global session revocation. Add the missing suspend path while you are there: a `PUT /admin/users/:id` that sets users.status and bumps token_version, since today the only lever is psql and it does not work. For full rotation-with-reuse-detection add a `refresh_tokens(user_id, token_hash, family_id, used_at, expires_at, revoked_at)` table consumed atomically the way userTokenService.ts:62-72 already does it, revoking the family when a used token is presented again. Also pin `algorithms: ['HS256']` and set issuer/audience on sign and verify (see the jwt-alg finding).

### The global 120/min-per-IP limiter runs ahead of everything and makes the 600/min per-key budget unreachable
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/index.ts:57` — authsec — status: CONFIRMED

**Evidence.** index.ts:57 `app.use(globalRateLimiter)` sits before both `/health` (index.ts:60) and `app.use('/api/v1', buildRouter())` (index.ts:68). rateLimit.ts:28-35 passes no keyGenerator and no skip, so it uses express-rate-limit's default (client IP) with `max: config.rateLimit.max`; .env:88-89 has RATE_LIMIT_WINDOW_MS=60000 and RATE_LIMIT_MAX=120 (same in .env.example:140-141). apiKeyRateLimiter (rateLimit.ts:139-151) is keyed on `req.client.apiKeyId` with `max: config.rateLimit.apiKeyMax` = 600 (.env:91) and is chained at the very END of merchantAuth (auth.ts:157), i.e. strictly after the global one. 120 < 600, so the per-key ceiling is unreachable and the design note at rateLimit.ts:130-138 explaining why an IP limit is wrong for server-to-server traffic is defeated by the limiter mounted above it. `app.set('trust proxy', 1)` (index.ts:29) means req.ip is the real client, so every merchant behind one NAT egress and every checkout customer behind one carrier CGNAT shares a single 120/min bucket. At 1,000 concurrent from a handful of merchant server IPs, roughly 120 succeed per minute per IP and the rest get 429 before the API key is ever looked up — a sustained ceiling of 2 req/s per merchant, which cannot carry the stated 100k/day. Also confirmed: /health is mounted after the limiter, so orchestrator probes consume the same bucket.

**Fix.** backend/src/middleware/rateLimit.ts:28-35 — add `skip: (req) => Boolean(req.headers['x-api-key'] || req.headers.authorization)` to globalRateLimiter so credentialed traffic is governed solely by apiKeyRateLimiter (per key) and the checkout limiters (per IP, already correctly sized at rateLimit.ts:75-101), and add an explicit `keyGenerator` built on express-rate-limit's exported `ipKeyGenerator` helper so IPv6 clients bucket by /64 rather than per-address. In backend/src/index.ts:57-62, move the `/health` route above `app.use(globalRateLimiter)` so a liveness probe can never be throttled. Then size API_KEY_RATE_LIMIT_MAX from the real target: 100k payments/day plus status polling across N merchants is roughly 1,200-3,000/min for a busy one — 600 is likely still too low, so set it per-plan (an `api_keys.rate_limit_max` column read in apiKeyRateLimiter's `limit` callback) rather than one global number.

### A rejected eth_getLogs stalls the reconciler — the range is never narrowed and the remaining assets are skipped
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmListener.ts:484` — blockchain — status: DOWNGRADED

**Evidence.** Verified: `MAX_SCAN_RANGE = 2_000` at line 99 is a `const` with no module-level mutable counterpart and no adaptive narrowing anywhere in the file. The catch at lines 479-485 logs and does `return; // do NOT advance the cursor — retry the whole range next pass`, so the identical (fromBlock, scanTo) is re-issued every 5 s forever. Worse than reported: that `return` sits INSIDE the `for (const asset of tokenAssetsFor(cfg.network))` loop at line 472, so a failure on the first asset also skips every remaining asset's queryFilter in that pass. usdt.ts:53-70 documents that a public BSC node has already rejected this deployment's traffic once with `-32005 method eth_getLogs in batch triggered rate limit`. DOWNGRADED from critical because the premise 'catch-up puts the range at the full 2,000 blocks' is only true when the cursor is far behind. In steady state lastScanned ≈ safeHead, so scanTo - fromBlock is ~7-11 blocks on BSC and ~1 on Ethereum — servable by every endpoint. The permanent-stall outcome therefore requires either the genesis cursor (evm-cursor-starts-at-genesis, confirmed) or an outage longer than ~15 minutes. It is the amplifier that turns those into permanent, not an independent critical.

**Fix.** In backend/src/blockchain/evmListener.ts: (1) replace the `MAX_SCAN_RANGE` constant with a module-level `let scanRange = MAX_SCAN_RANGE;`, halve it on a caught queryFilter error down to a floor of 10, and restore it (`scanRange = Math.min(MAX_SCAN_RANGE, scanRange * 2)`) after a clean pass. (2) Move the try/catch so a failure on one asset `continue`s to the next asset and only suppresses the cursor advance, instead of `return`ing out of the whole pass — track a `let anyFailed = false` and skip the UPDATE at 513-516 when it is set. (3) Chunk the call: issue `queryFilter(filter, b, Math.min(scanTo, b + scanRange - 1))` in a loop over the window rather than one call for the whole range, and chunk `watched` (line 471) into batches of ~200 addresses so request body size is bounded. (4) Export `safeHead - lastScanned` and a consecutive-failure counter as metrics, and fail the listener's health check when either exceeds a threshold — today the only signal is one logger.error line per 5 s.

### Promotion confirms EVERY pending row for the payment, so a zero-confirmation transfer is credited and paid out
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmAdapter.ts:333` — blockchain — status: CONFIRMED

**Evidence.** Confirmed, and the root cause is sharper than the report states. evmAdapter.ts:332-334 reads `const balanceU: bigint = await tokenRead.balanceOf(depositAddress)` at head with the comment 'On-chain balance is the source of truth (not amount_received)', and workers/index.ts:98 then feeds that straight into requestPayout at 140-151 as `amount: balanceHuman`. But the real defect is evmListener.ts:631-637: after ONE row clears the depth test, the UPDATE marks `status='confirmed'` for EVERY row `WHERE payment_id = $1 AND direction='incoming' AND status='pending'` — with no per-row depth check. So a transfer recorded by the WS fast path (evmListener.ts:358-377) at the live head, with zero confirmations, is stamped confirmed by a promotion triggered entirely by an older, deep transfer. It is also already inside `amount_received`, because RECEIVED_SUM (lines 88-94) sums all non-reorged incoming rows and recordIncoming recomputes it at line 258. I checked whether payoutService would catch it: requestPayout does hold a per-(client,network) advisory lock and compare against `SUM(amount_received) FROM payments WHERE status IN ('confirmed','swept')` (payoutService.ts:171-186, 468-472) — but since amount_received already includes the 0-conf transfer, the guard passes and the full amount is paid out. Requires BSC_WS_RPC to be set (the reconciler alone only records blocks <= head - reorgDepth), which is the recommended production configuration per docs/deployment.md:136-138. Combined with the confirmed inability to unwind a swept payment, that money leaves the operator's hot wallet against a deposit that has had no finality at all.

**Fix.** Fix it at the promotion, not at the sweep. In backend/src/blockchain/evmListener.ts, narrow the UPDATE at lines 631-637 to `... AND ($2 - block_number) >= (SELECT required_confirmations FROM payments WHERE id = $1)`, binding head as $2, so only rows that individually cleared the threshold become 'confirmed'. Then move amount_received onto that basis: change RECEIVED_SUM (lines 88-94) to `AND bt.status = 'confirmed'` for the promoted total, or add a second `amount_confirmed` column summed over confirmed rows only, and change workers/index.ts:140-151 to request the payout against that value instead of `balanceHuman`. Keep sweeping the full on-chain balance (it is the gateway's own address either way) — the excess is then credited by the next promotion pass once it has depth, rather than paid out at zero confirmations. Apply the same narrowing to tronListener.ts:450-455 and bitcoinListener.ts:201-206.

### The fixed gas top-up is 10-140x the actual fee and the remainder is stranded at a dead deposit address, with no automatic recovery
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmAdapter.ts:126` — blockchain — status: CONFIRMED

**Evidence.** Confirmed on every leg. evmAdapter.ts:126-128: under the fixed policy `requiredGasTopup` returns `parseEther(cfg.gasPolicy.topupAmount)` before any getFeeData() call — the gas price is read only in the dynamic branch at line 131. BSC uses fixed (evmChains.ts:105 `gasPolicy: { mode: 'fixed', topupAmount: config.settlement.gasTopupBnb }`) with GAS_TOPUP_BNB default '0.0008' (config/env.ts:247). I computed the residual: at 55,000 gas the fee is 0.0000055 BNB at 0.1 gwei, 0.000055 at 1 gwei, 0.000165 at 3 gwei — leaving 0.000795 / 0.000745 / 0.000635 BNB stranded per token sweep. It is never recovered: evmAdapter.ts:320-328 routes to sweepNativeDeposit only when `asset.isNative`, which is false for every USDT/USDC payment, and I grepped the whole backend for a reclaim/residual job — the only callers of sweepNativeDeposit are line 321 and recover.ts's manual `--native <index>` path. Line 359 also tops up the FULL `topupWei` rather than `topupWei - nativeBalance`. Tron is the same shape with worse numbers: TRON_GAS_TOPUP_TRX default '30' (config/env.ts:252), sent flat at tronAdapter.ts:275-286 against a ~13-27 TRX energy burn. And the floor/top-up denomination mismatch is real: assets.ts:285 sets TRC20 USDT minSweep from config.tron.minSweepAmount ('1.0', config/env.ts:251), checked at tronAdapter.ts:263-269 as `balanceU < toTronBaseUnits('1.0', 6)`, so exactly 1,000,000 base units passes and triggers a 30 TRX (~$3-9) top-up. ONE CORRECTION to the report's economics: the attacker does NOT recover their 1 USDT — it is swept to central and credited to the merchant — so this is griefing (burn ~$1 to strand ~$1-5 of the operator's TRX), not a profitable drain. The ordinary-operation bleed is the stronger half and needs no attacker.

**Fix.** In backend/src/blockchain/evmChains.ts, switch BSC (line 105) from `{ mode: 'fixed', topupAmount: ... }` to `{ mode: 'dynamic', fallbackTransferGas: 70_000n, bufferPercent: 50, maxFeeNative: config.settlement.gasTopupBnb }` — the dynamic branch at evmAdapter.ts:130-171 already prices from getFeeData() x estimateGas x buffer and already treats the configured value as a ceiling, so GAS_TOPUP_BNB keeps its meaning as a cap instead of a flat spend. In evmAdapter.ts:359-378 top up the DIFFERENCE: `const need = topupWei - nativeBalance; if (need > 0n) { ... value: need ... }`. In backend/src/blockchain/tronAdapter.ts:274-286, size the top-up from `tronWeb.trx.getAccountResources(depositAddress)` energy and the current energy price plus a buffer, capping at config.tron.gasTopupTrx rather than always sending it. Add a reclaim worker that periodically selects deposit addresses whose payment is 'swept', reads the native balance, and runs the existing sweepNativeDeposit logic when it exceeds 2x the transfer fee. Finally, denominate the per-asset minSweep floors (assets.ts:83, 193) against the current fee cost — refuse to sweep when `minSweep_value < k x topup_value` — so a 1 USDT deposit can never trigger a 30 TRX top-up.

### Every deposit address re-derives the HD root from the mnemonic — 4.55 ms of synchronous CPU per payment blocks the whole API
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/utils/hdwallet.ts:26` — blockchain — status: CONFIRMED

**Evidence.** Confirmed and measured on this machine with the installed ethers. hdwallet.ts:26-30 `rootFromMnemonic()` does `Mnemonic.fromPhrase(...)` + `HDNodeWallet.fromMnemonic(mnemonic)` on every call, and BOTH deriveAddress (line 70) and derivePrivateKey (line 85) call it, then walk the full absolute path. Measured: full derive 4.55 ms/call, of which HDNodeWallet.fromMnemonic alone is 2.02 ms (PBKDF2-HMAC-SHA512, 2048 iterations, pure JS, fully synchronous); deriving a child from a cached account node is 0.28 ms — a 16x reduction. The same rebuild-per-call pattern is at blockchain/bitcoin.ts:87-90 (`accountNode()` builds the mnemonic and account node fresh, called by deriveBtc) and utils/tronHdwallet.ts. The API path is confirmed: paymentService.ts:239 `const derived = adapter.deriveDeposit(index);` sits inside the payment transaction body, one call per POST /payments. Node is single-threaded, so this is un-yieldable blocking of every other route, not just of payment creation. One nuance worth knowing when prioritising: getNextDerivationIndex (hdwallet.ts:50-63) takes an `UPDATE hd_counter ... RETURNING` row lock held to COMMIT, so concurrent creations already serialise on that row — but the derivation cost is CPU on the shared event loop, which the row lock does nothing about, and it blocks health checks and HMAC verification for unrelated requests.

**Fix.** In backend/src/utils/hdwallet.ts, cache the account node once per process: `let ACCOUNT: HDNodeWallet | null = null; function accountNode(): HDNodeWallet { if (!ACCOUNT) ACCOUNT = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(config.hd.mnemonic.trim())).derivePath(relativePath(config.hd.derivationPath.replace(/\/+$/, ''))); return ACCOUNT; }`, then make deriveAddress and derivePrivateKey call `accountNode().deriveChild(Number(index))`. The last path element is non-hardened, so this is exactly equivalent — assert that at startup by comparing the two derivations for index 0 and throwing if they differ, which also protects against an operator configuring HD_DERIVATION_PATH with a hardened final element. Apply the same memoisation to `accountNode()` in backend/src/blockchain/bitcoin.ts:87-90 (it already derives an account node, it just rebuilds it every call) and to backend/src/utils/tronHdwallet.ts. Keep the decrypt seam in rootFromMnemonic's doc comment by decrypting once inside the lazy initialiser.

### A single-use invoice link is consumed the instant a payment is STARTED and is never released on expiry — the invoice becomes permanently unpayable, and any URL holder can do it deliberately
`backend/src/services/paymentLinkService.ts:372` — business-logic — status: CONFIRMED

**Evidence.** Every step verified. invoiceService.ts:396-416 mints the invoice's pay link with `VALUES ($1,...,false, 1)` — reusable=false, max_uses=1. claimLinkUse increments at the moment of payment CREATION: `UPDATE payment_links SET use_count = use_count + 1` (paymentLinkService.ts:372-376), and unusableReason refuses everything afterwards via `if (r.max_uses !== null && r.use_count >= r.max_uses) return 'This payment link has already been used.'` (:155-157), which claimLinkUse throws on at :369-370. I grepped use_count across the entire repo (backend + sql): it is written in exactly one place, paymentLinkService.ts:373. Nothing decrements it. processExpiry (workers/index.ts:165-172) touches only payments.status and never looks at payment_link_id. No route resets it — invoices expose only list/create/get/send/void (routes/invoices.ts:63,74,112,121,146). Recovery really is void + re-create: voidInvoice refuses a paid invoice (invoiceService.ts:607-611) and disables the link (:616-621), and for a subscription-minted invoice the cycle cannot be re-billed because uq_invoices_subscription_cycle (schema.sql:443-445) blocks (subscription_id, cycle_number) reuse and no re-bill route exists. The unauthenticated denial-of-payment is real: POST /pay/:token/payments (routes/paymentLinks.ts:163-166) has no auth, only checkoutWriteLimiter at 10/min per IP (middleware/rateLimit.ts:91-101) — and burning a link costs exactly one request. One correction to the auditor's framing: this product's own checkout does NOT create the payment on page load — client-panel/src/pages/public/Checkout.tsx:428 fires `start` from a button click. So the accidental case is 'customer clicks Continue, sees the address, then abandons or pays late', not 'anyone who opens the URL'. That is still the single most common checkout outcome, and it compounds with the late-payment finding: the customer who pays at T+31min both loses their funds and leaves the invoice unpayable.

**Fix.** Separate 'started' from 'consumed'. In claimLinkUse, before the usability check at :369, look for a live payment on the link inside the same transaction: `SELECT id FROM payments WHERE payment_link_id = $1 AND status IN ('waiting','confirming','partial') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`. If one exists, return it to the caller instead of claiming a use — routes/paymentLinks.ts:195-209 then returns that existing payment's address/QR rather than calling createPayment, so a returning or refreshing customer resumes. Second, release the claim on a dead payment: in processExpiry (workers/index.ts:167-172), change the UPDATE to `RETURNING id, payment_link_id, amount_received` and, for rows with a link and amount_received = 0, run `UPDATE payment_links SET use_count = GREATEST(0, use_count - 1) WHERE id = ANY($1)` — do this inside one transaction with the expiry UPDATE so a crash cannot release a use without expiring the payment. Third, do not count the use at creation at all for max_uses purposes: move the increment to the transition into 'confirming' (evmListener.ts:256-264 and siblings already have the guarded UPDATE to hang it on), which makes 'used' mean 'someone actually sent money'. Also add the public-checkout resume path to Checkout.tsx by persisting paymentId in sessionStorage so a refresh does not strand the customer.

### Webhook delivery is abandoned permanently after ~12 minutes, and there is no redelivery mechanism anywhere in the product
`backend/src/workers/queues.ts:27` — business-logic — status: CONFIRMED

**Evidence.** Arithmetic verified against the library. workers/queues.ts:27-32 sets `attempts: Math.max(1, config.webhook.maxRetries)` with `backoff: { type: 'exponential', delay: 5_000 }`; config/env.ts:257 defaults WEBHOOK_MAX_RETRIES to 8. bullmq/dist/cjs/classes/backoffs.js:36-45 computes `Math.round(Math.pow(2, attemptsMade - 1) * delay)`, so the seven retry gaps are 5s, 10s, 20s, 40s, 80s, 160s, 320s = 635s, plus 8 attempts of up to WEBHOOK_TIMEOUT_MS=8000 (config/env.ts:258, applied via AbortController at webhookService.ts:193-194) = 64s. Total ceiling ~11.6 minutes, then removeOnFail: 5000 and the job is gone. I searched the whole backend for a redelivery path: GET /account/webhook-logs (routes/account.ts:928-970) is read-only and there is no POST anywhere on webhook_logs; grep for 'redeliver' returns nothing. processSettle (workers/index.ts:196-282) re-drives sweeps and payouts and reconciles invoices, but never re-drives a webhook — so a webhook lost at enqueue time (listener failures are only logged: evmListener.ts:644-646, :729-730; workers/index.ts:132, :180) is lost permanently too. The 1-hour cap the author clearly intended sits unused at webhookService.ts:220-223 and is applied only to the display column. Kept at high: a merchant outage longer than 12 minutes permanently discards payment.confirmed for every payment settled in that window, with no product surface to recover it — the customer has paid, the gateway is correct, and the merchant's order stays unfulfilled with nothing in the UI to click.

**Fix.** Register a custom BullMQ backoff on the webhook Worker in workers/index.ts:297-301 — `settings: { backoffStrategy: (attemptsMade) => Math.min(3_600_000, 5_000 * 2 ** (attemptsMade - 1)) }` — set `backoff: { type: 'custom' }` in queues.ts:29, and raise WEBHOOK_MAX_RETRIES to ~20, which spans just over 24 hours with the 1-hour cap. Export that same function and use it for next_retry_at at webhookService.ts:220-223 so the two cannot drift (this also closes 'next-retry-at-misreported'). Add POST /account/webhook-logs/:id/redeliver behind clientAuth + requireDashboardSession that re-enqueues `webhookQueue.add('deliver', { webhookLogId })` for a row owned by that client, and an admin bulk replay by (client_id, event, created_at range). Add a per-client circuit breaker keyed in Redis: after K consecutive failures for a client_id, have dispatch fail fast for a cooldown rather than spending 8s per attempt, and drain the backlog on the first success.

### EVM listener advances the block cursor past blocks it scanned with a stale deposit-address set, permanently missing deposits into freshly created payments
`backend/src/blockchain/evmListener.ts:466` — concurrency — status: DOWNGRADED

**Evidence.** The MECHANISM is exactly as described and I could not find any mitigation. The SEVERITY claim rests on a timing argument that does not survive arithmetic, so: critical -> high.

Mechanism, confirmed:
- evmListener.ts:471-476: `const watched = Array.from(depositAddresses); ... const filter = token.filters.Transfer(null, watched);` — the scan is filtered by the in-memory set, so an unknown address returns no logs.
- evmListener.ts:513-516: `UPDATE chain_cursor SET last_scanned_block = $1` runs unconditionally after the scan. The only early return that skips it is the queryFilter catch at :484.
- fromBlock is always `lastScanned + 1` (evmListener.ts:455). There is no rewind anywhere; I grepped every write to `last_scanned_block`.
- The set is only repopulated on an independent timer: `ADDRESS_REFRESH_MS = 30_000` (:97), `setInterval(refreshDepositAddresses, ADDRESS_REFRESH_MS)` (:783-787). The API creating the payment runs in a different process with no notification path.
- The WS fast path is gated on the same set (`if (!depositAddresses.has(to.toLowerCase())) return`, :362), so it does not cover the gap.
- The auditor is right that this is EVM-only: tronListener.ts:137-149 sets each address's floor to `MIN(created_at) - 1h` and re-queries from it every pass, and bitcoinListener.ts:232-241 re-reads full address history — both self-heal once the address appears.

Why I downgraded. Loss requires the containing block to be SCANNED before the address is known. Scan time ≈ mined + reorgDepth×blockTime + up to one 5s pass. With REORG_DEPTH=15 (.env) and BSC's sub-second blocks that lag L ≈ 11-16s, while the refresh offset Δ ~ U(0,30s). Exposure is max(0, Δ − L), so the expected window is (30−13)²/60 ≈ 5 seconds after payment creation, capped at ~17s — not the ~9s average / 23s worst case claimed, and it requires the customer's transaction to be MINED within ~5s of the checkout being created. That is not 'the single most common customer behaviour'; a human rendering a page, opening a wallet and confirming does not get mined in 5 seconds. On Ethereum the finding does not fire at all: ETH_REORG_DEPTH at ~12s blocks puts L well above the 30s refresh period, so the window is always zero.

It stays HIGH rather than medium because when it does fire the outcome is worse than any other finding here: no log, no `unexpected_deposits` row (recordUnexpectedDeposit is only reached from recordIncoming, which is never called), the payment simply expires, and there is no recovery short of a hand-run block-range rescan. Automated/programmatic payers (exchange withdrawals, bot-driven checkouts) do land inside the window.

**Fix.** One-line close for the common case, in evmListener.ts:

(a) Make the watch set consistent with the range being scanned — refresh immediately before every pass instead of on an independent timer. At the top of `reconcileOnce` (before line 439) add `await refreshDepositAddresses();`, and demote the :783-787 interval to a long backstop (e.g. 5 minutes). The query is `SELECT DISTINCT deposit_address FROM payments WHERE status IN (...) AND network = '...'`, which is served by `idx_payments_network_status` (schema.sql:362), so running it every 5s is cheap.

(b) Close the create-mid-pass residue: record the block height at payment creation. Add `payments.created_block BIGINT` and have createPayment stamp the listener's last known head (or derive it from `created_at` and the chain's block time). Then in reconcileOnce clamp the start of the range:
```sql
SELECT COALESCE(MIN(created_block), $1) AS floor
  FROM payments
 WHERE network = $2 AND status IN ('waiting','confirming','partial')
```
and use `fromBlock = min(lastScanned + 1, floor)`.

(c) Backstop for what is already lost: a periodic job that, for every payment that expired with `amount_received = 0`, runs `getLogs` for that single address over `[created_block, expired_block]`. That is one cheap targeted query per expired payment and turns an invisible loss into an `unexpected_deposits` row.

### `executePayout` and `executeAdminWithdrawal` guard against re-broadcast with a stale in-memory row snapshot instead of a DB compare-and-set
`backend/src/services/payoutService.ts:253` — concurrency — status: DOWNGRADED

**Evidence.** The DEFECT is real and precisely described; the stated TRIGGER is wrong, which is why this drops critical -> high.

Defect, confirmed verbatim:
- payoutService.ts:245-248 reads the row once on the pool.
- :253 `if (payout.status === 'sent' || payout.status === 'confirmed') return;` — note it does NOT reject `processing`.
- :261 `await query(\`UPDATE payouts SET status = 'processing' WHERE id = $1\`, [payoutId]);` — unconditional, no `AND status IN (...)`, no RETURNING, no rowcount check.
- :274-279 builds `state` from that same pre-lock snapshot, and chainBroadcast.ts:100-131 branches on `state.signedTx` / `state.broadcastAt` without ever re-reading. So the window between 'status→processing' and `persistPrepared` (payoutService.ts:283-290) is genuinely unprotected, and that window includes the up-to-45s chainLock acquire (chainLock.ts:50, 103-110). A second executor inside it derives nonce=null -> evmAdapter.ts:459-460 fetches a fresh pending nonce -> a genuinely different second transfer. adminCommissionService.ts:207, 214, 232 is character-for-character the same shape.

Why the trigger is wrong. The auditor blames a blocked event loop from `derivePrivateKey`'s synchronous PBKDF2. I measured it on this machine with the repo's own ethers: 3.43ms per uncached call (1.34ms with a cached root). BullMQ's defaults are lockDuration 30_000 / stalledInterval 30_000, and the workers are constructed with no overrides (workers/index.ts:309-313, `{ connection, concurrency: 3 }`). A 3.4ms synchronous burst at sweep concurrency 3 cannot cause a 30-SECOND lock-renewal miss. Nor can the 45s chainLock wait: chainLock.ts:109 is `await sleep(100)` in a loop, so the event loop stays free and BullMQ renews normally.

So the only real path to concurrent execution of the SAME payoutId is a genuine >30s stall of lock renewal — a Redis outage or hiccup, a host/GC pause, or CPU starvation of the worker container. Real at the stated load, but infrastructural rather than routine, and BullMQ retries do NOT reach it (attempt N+1 starts only after attempt N returned, and by then signed_tx is persisted so chainBroadcast.ts:101-107 takes the safe re-broadcast branch).

Double payment when it does fire is unrecoverable, and the fix is three lines, so HIGH.

**Fix.** Make the transition a compare-and-set and re-read state under the chain lock.

(a) payoutService.ts — replace lines 245-261 with a claiming UPDATE and build `state` from its result:
```ts
const claimed = await queryOne<PayoutRow>(
  `UPDATE payouts SET status = 'processing'
     WHERE id = $1
       AND status IN ('pending','failed')
   RETURNING *`,
  [payoutId],
);
if (!claimed) {
  logger.info({ payoutId }, 'payout not claimable (already processing/sent/confirmed); skip');
  return;
}
const payout = claimed;   // everything below reads from the claimed row
```
Excluding `processing` from the claimable set is the whole point: it makes a stalled-job redelivery a no-op instead of a second signer. Pair it with a BullMQ `stalledInterval`/`lockDuration` bump on the payout worker so a legitimately slow job is not repeatedly abandoned.

(b) chainBroadcast.ts — add an optional `reloadState?: () => Promise<BroadcastState>` to `BroadcastRequest` and call it as the FIRST statement inside the `withChainLock` callback at :100, before branching on `state.signedTx` / `state.broadcastAt`. Then the decision is made on data observed after the lock was held, not before it was requested. Have payoutService pass `async () => { const r = await queryOne('SELECT nonce, signed_tx, broadcast_at, tx_hash FROM payouts WHERE id=$1', [payoutId]); return {...}; }`.

(c) Apply (a) and (b) identically to adminCommissionService.ts:207-232.

(d) Belt and braces, and the one that does not depend on getting BullMQ's tuning right: wrap the whole of executePayout in `SELECT pg_advisory_xact_lock(8123, hashtext('payout:' || $1))` so Postgres, not the queue, is the arbiter of single execution.

### HD index allocation holds a global `hd_counter` row lock across a synchronous key derivation, serialising every payment creation in the cluster
`backend/src/utils/hdwallet.ts:50` — concurrency — status: CONFIRMED

**Evidence.** Confirmed, including the measurement.

- hdwallet.ts:51-56 is `UPDATE hd_counter SET next_index = next_index + 1 WHERE id = 1 RETURNING next_index - 1`. The allocation itself is correct — hd_counter is a one-row table (schema.sql:252-256, `id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`), the row lock plus RETURNING-sees-post-update means two callers cannot get the same index, and `idx_wallets_deriv` (schema.sql:245, UNIQUE on derivation_index WHERE type='deposit') is a genuine backstop. That part is right and should be stated as such.
- The docstring at hdwallet.ts:47-48 ('takes a row lock for the duration of the statement') is the error: Postgres holds row locks to COMMIT.
- paymentService.ts:239-240 calls `getNextDerivationIndex(client)` then `adapter.deriveDeposit(index)` INSIDE the transaction, followed by the wallets INSERT (:243-248), the payments INSERT (:252-286) and COMMIT. Every one of those is inside the lock.
- deriveDeposit -> deriveAddress (hdwallet.ts:68-77) -> `rootFromMnemonic()` (hdwallet.ts:26-30) rebuilds the master node from the phrase on EVERY call. No memo anywhere in the module.

I measured it with the repo's own ethers and the mnemonic from .env:
  uncached (as written): 3.429 ms/call
  cached root:           1.337 ms/call
Fully synchronous, so it blocks the event loop of whichever API replica holds the lock.

So the exclusive critical section is: BEGIN -> duplicate SELECT -> UPDATE hd_counter -> ~3.4ms blocking CPU -> INSERT wallets -> INSERT payments -> COMMIT, i.e. roughly 5-10ms per payment cluster-wide, capping creation at ~100-200/s no matter how many replicas are added.

The pool interaction is real: pool.ts:16-18 hardcodes `max: 20` and `connectionTimeoutMillis: 10_000`, and node-postgres applies connectionTimeoutMillis to the ACQUIRE wait, not just TCP connect. A transaction blocked on the row lock still holds its connection, so 19 of 20 connections sit idle-blocked while one progresses. 1000 queued creations drain in 5-10s, which lands on top of the 10s acquire timeout and surfaces as `Error: timeout exceeded when trying to connect` -> the generic 500 branch of errorHandler (apiError.ts:97-98). Note this starves every other endpoint in the same process too, since pool.query shares the pool.

**Fix.** Three independent changes; (a) and (b) together take the exclusive hold from ~5-10ms to ~1-2ms.

(a) hdwallet.ts — memoise the master node:
```ts
let cachedRoot: HDNodeWallet | null = null;
function rootFromMnemonic(): HDNodeWallet {
  if (!cachedRoot) {
    cachedRoot = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(config.hd.mnemonic.trim()));
  }
  return cachedRoot;
}
```
3.429ms -> 1.337ms, measured, for a four-line change. (It does keep the seed resident, which it already effectively is via config.hd.mnemonic.)

(b) Get the allocation and the derivation out of the transaction entirely. Replace the counter with a sequence, which takes no row lock at all:
```sql
CREATE SEQUENCE IF NOT EXISTS hd_deposit_index AS BIGINT START WITH <current hd_counter.next_index>;
```
```ts
const index = Number((await query<{n: string}>(`SELECT nextval('hd_deposit_index') AS n`))[0].n);
const derived = adapter.deriveDeposit(index);   // outside any transaction
const row = input.tx ? await body(input.tx, index, derived) : await withTransaction((c) => body(c, index, derived));
```
Gaps from a rolled-back creation are harmless — indexes are never reused, and `idx_wallets_deriv` still guarantees uniqueness. Keep hd_counter as the seed for the sequence's START WITH and drop it after the cutover.

(c) pool.ts:16 — make the size deliberate: `max: Number(process.env.PG_POOL_MAX ?? 20)`, and put PgBouncer in transaction mode in front of Postgres so N API replicas × 20 plus workers plus three listeners do not exhaust a default `max_connections = 100`.

### The Tron listener issues one sequential HTTP request per watched address per pass, so detection latency scales linearly with the number of live payments
`backend/src/blockchain/tronListener.ts:493` — concurrency — status: CONFIRMED

**Evidence.** Confirmed for Tron. The Bitcoin half is real but much less severe than presented, and I have narrowed the title accordingly.

Tron, confirmed:
- tronListener.ts:493 `for (const [address, sinceMs] of depositAddresses) {` — a serial for-of with `await fetchInboundNative(address, sinceMs)` at :500, `await fetchInboundTransfers(address, sinceMs, asset)` at :514 inside a nested per-asset loop, and `await blockNumberOf(t.transaction_id)` at :526 for every discovered transfer. Every call is awaited before the next begins; there is no bounded-concurrency map anywhere.
- The code concedes the shape itself at :485-487: 'That is O(addresses x assets) requests per pass'.
- POLL_INTERVAL_MS = 5_000 (:54) with a `running` re-entrancy guard at :565-574 that silently SKIPS ticks, so overrun manifests as unbounded latency rather than an error anyone would see.
- At A=1000 watched addresses (PAYMENT_EXPIRY_MINUTES=30 means an address is watched for the full half hour) and one TRC20 asset, that is 1000 sequential TronGrid round trips plus one receipt lookup per transfer. At an optimistic 50ms each the pass is ~50s against a 5s timer; TronGrid without an API key rate-limits far below that and each 429 compounds it. Detection latency stretches into minutes, which then feeds the expiry race (payments start expiring before they are ever seen).

Bitcoin, downgraded within the finding: bitcoinListener.ts:232 has the same serial structure, but POLL_INTERVAL_MS = 30_000 (:55) against ~10-minute blocks and BTC_REQUIRED_CONFIRMATIONS default 2. Even a 50s pass is comfortably inside one block, so the linear fan-out costs API quota and delays confirmation counts, not detection correctness. It should be fixed for quota reasons, not because BTC 'does not function'.

**Fix.** (a) Bound and parallelise the fan-out. Replace the serial loop at tronListener.ts:493-531 (and bitcoinListener.ts:232-258) with a fixed-width worker pool:
```ts
const CONCURRENCY = 12;   // stay inside TronGrid's per-key limit
const entries = [...depositAddresses];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < entries.length) {
    const [address, sinceMs] = entries[cursor++];
    await scanOneAddress(address, sinceMs);   // the existing body, extracted
  }
}));
```
Wall clock drops from A×(K+1)×rtt to A×(K+1)×rtt/CONCURRENCY. Keep the existing per-address try/catch inside scanOneAddress so one failure still only skips that address.

(b) Drop the per-transfer receipt lookup at tronListener.ts:526. `blockNumberOf` exists only because the TRC20 list endpoint omits blockNumber — but it also serves to reject reverted transfers. Replace it with `block_timestamp`-to-height estimation for the confirmation count and keep a single receipt check only for transfers about to cross the promotion threshold, or move to TronGrid's `/v1/accounts/{addr}/transactions/trc20` with `only_confirmed=true` (already set at :171) and trust solidification, which the file header at :18-23 already argues is final.

(c) Prioritise the watch set: sort `depositAddresses` so addresses whose payment was created most recently, or that already have a pending incoming row, are scanned first, and poll old-but-still-waiting addresses every Nth pass. A 30-minute-old unpaid address does not need 5-second granularity.

(d) Add a pass-duration metric and log a warning when a pass exceeds POLL_INTERVAL_MS. Right now the `running` guard at :565-574 makes overrun completely silent, which is why this would reach production undetected.

### Every API request 500s when Redis is unavailable, because express-rate-limit defaults to failing closed
`backend/src/middleware/rateLimit.ts:28` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Verified against the vendored library, and the timing is worse than reported.

`buildStore` (rateLimit.ts:13-25) only guards CONSTRUCTION — its own comment says so — and returns `undefined` on a constructor throw. It does nothing for a runtime failure. In express-rate-limit 7.5.1, dist/index.cjs:671 sets `passOnStoreError: false` as the default, and :712-726 reads `try { const incrementResult = await config.store.increment(key); } catch (error) { if (config.passOnStoreError) { … next(); return; } throw error; }`. The throw is caught by `handleAsyncErrors` at :689-694 (`await Promise.resolve(fn(...)).catch(next)`) and becomes `next(error)`. None of the seven limiters in rateLimit.ts sets `passOnStoreError` (28, 38, 55, 75, 91, 116, 139). `globalRateLimiter` is mounted at index.ts:57 with `app.use(...)` and no path, so it fronts every route including `/health` (index.ts:60), the docs (:65) and all of `/api/v1` (:68). utils/apiError.ts renders the result as a 500 `internal_error`.

The shared client does reject rather than hang — that half of the reasoning is right and I confirmed the mechanism: db/redis.ts:14 sets `maxRetriesPerRequest: 3`, and ioredis event_handler.js:198-209 flushes the queue with `MaxRetriesPerRequestError` when `retryAttempts % (maxRetriesPerRequest + 1) === 0`, i.e. every 4th reconnect attempt.

SHARPENING: because the flush is tied to reconnect attempts and ioredis's default retryStrategy is `Math.min(times * 50, 2000)`, the flush interval starts at ~200ms but stretches to ~8s once the backoff saturates. So requests do not fail fast — they hang for up to 8 seconds and then 500, holding sockets and event-loop state the whole time. Under load that converts a Redis blip into connection exhaustion at the proxy as well as a 500 storm.

**Fix.** backend/src/middleware/rateLimit.ts:
(1) Add `passOnStoreError: true` to the five limiters where availability beats protection: globalRateLimiter (:28), checkoutReadLimiter (:75), checkoutWriteLimiter (:91), invoiceSendLimiter (:116), apiKeyRateLimiter (:139).
(2) Do NOT fail open on the two credential-facing limiters. For authRateLimiter (:38) and signupRateLimiter (:55), keep `passOnStoreError: false` but give them a working fallback so a Redis outage degrades them to per-instance limits instead of 500s: build them with `store: buildStore('rl:auth:') ?? undefined` (already the shape) and add a second guard — wrap the store's `increment` so a rejection falls through to an in-process `MemoryStore` from express-rate-limit rather than throwing. Concretely, in `buildStore` return a small proxy: `{ init, increment: async (k) => { try { return await redisStore.increment(k); } catch (err) { logger.warn({ err }, 'rate-limit store failed; using memory fallback'); return memStore.increment(k); } }, decrement, resetKey }`.
(3) Bound the hang so a store failure is fast: set `commandTimeout: 2000` on the shared client in db/redis.ts:13-16. ioredis honours it at Redis.js:352-354 (`if (typeof this.options.commandTimeout === "number") command.setTimeout(...)`), which converts the ~8s worst case into a 2s ceiling.
(4) Move `/health` above `app.use(globalRateLimiter)` — see the separate finding.

### Payment creation blocks the event loop for ~5.2ms of synchronous crypto and PNG encoding, 3.6ms of it while holding the global `hd_counter` row lock
`backend/src/utils/hdwallet.ts:70` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Every number reproduced on this box with the repo's own ethers and qrcode:
  deriveAddress (uncached root)  3.644 ms
  derivePath (cached root)       1.410 ms   → 2.23 ms is the re-derived BIP-39 seed
  QRCode.toDataURL               1.582 ms

The cause is exactly where reported. hdwallet.ts:26-30 `function rootFromMnemonic() { const mnemonic = Mnemonic.fromPhrase(config.hd.mnemonic.trim()); return HDNodeWallet.fromMnemonic(mnemonic); }` — a full PBKDF2-HMAC-SHA512 seed derivation — is called fresh by `deriveAddress` (:70) and `derivePrivateKey` (:85) on every single call, for a value that is a pure function of a constant.

The lock interaction is real and load-bearing. paymentService.ts:239-240:
```
const index = await getNextDerivationIndex(client);
const derived = adapter.deriveDeposit(index);
```
`getNextDerivationIndex` (hdwallet.ts:50-63) runs `UPDATE hd_counter SET next_index = next_index + 1 WHERE id = 1 RETURNING …` on the single-row table (schema.sql:252-256, `id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`), inside the caller's transaction, so the row lock is held until COMMIT. The 3.64ms derive and both INSERTs (paymentService.ts:243-249 and :253-278) run inside that window. Every payment creation across every API replica serialises on that one row for ~5-8ms → a deployment-wide ceiling of roughly 125-200 creations/second no matter how many replicas run.

One correction, which the reporter's own fix section already had right: `QRCode.toDataURL` is OUTSIDE the transaction (paymentService.ts:299-306, under the comment '4. QR (outside the txn — pure/no DB)'), so it does not extend the lock. It still blocks the shared event loop for 1.58ms per creation, and again per merchant status poll at paymentService.ts:326-335 for any `waiting`/`confirming` payment.

**Fix.** Three changes, largest win first.
(1) backend/src/utils/hdwallet.ts:26-30 — memoise the root. Removes 2.23ms of the 3.64ms:
```ts
let cachedRoot: HDNodeWallet | null = null;
function rootFromMnemonic(): HDNodeWallet {
  if (!cachedRoot) {
    cachedRoot = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(config.hd.mnemonic.trim()));
  }
  return cachedRoot;
}
```
The decrypt seam described in the comment at :20-25 still holds — decrypt once, cache the node, never cache the phrase.
(2) backend/src/services/paymentService.ts — take the derive out of the lock window. Cheapest correct form: reserve indexes in blocks per process. Add to hdwallet.ts:
```ts
let reserved: number[] = [];
const BLOCK = 64;
export async function nextIndex(client?: PoolClient): Promise<number> {
  if (reserved.length) return reserved.shift()!;
  const sql = `UPDATE hd_counter SET next_index = next_index + ${BLOCK} WHERE id = 1 RETURNING next_index - ${BLOCK} AS base`;
  const rows = client ? (await client.query<{ base: string }>(sql)).rows : await query<{ base: string }>(sql);
  const base = Number(rows[0].base);
  reserved = Array.from({ length: BLOCK }, (_, k) => base + k);
  return reserved.shift()!;
}
```
The row lock is then taken once per 64 payments instead of once per payment. Indexes are never reused and gaps are harmless (schema.sql:245 `CREATE UNIQUE INDEX idx_wallets_deriv ON wallets(derivation_index) WHERE type = 'deposit'` still holds). Note the tradeoff explicitly in a comment: a process restart discards up to 63 unused indexes.
(3) Get the QR off the request path. `adapter.paymentUri` (evmAdapter.ts:305-309) is pure string work; return it as a new `paymentUri` field on PaymentDTO and let the checkout/panel render the QR client-side. Keep `qrCode` populated only on createPayment for API back-compat, and delete the re-render at paymentService.ts:326-335 entirely — it recomputes a value that never changes for a payment whose address and amount are immutable.

### The global limiter caps every source IP at 120 requests/minute, so the 600/min per-key allowance is unreachable and the stated load cannot be served
`backend/src/middleware/rateLimit.ts:28` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Confirmed on every link of the chain.

Defaults: config/env.ts:319-320 `RATE_LIMIT_WINDOW_MS: numberish(60000)` and `RATE_LIMIT_MAX: numberish(120)`, surfaced at :604-608. globalRateLimiter (rateLimit.ts:28-35) uses both, with express-rate-limit's default IP keyGenerator (no `keyGenerator` override, unlike invoiceSendLimiter at :122 and apiKeyRateLimiter at :145).

Ordering: index.ts:57 `app.use(globalRateLimiter)` runs before the router is mounted at :68. The per-key limiter that IS sized for server-to-server traffic — `API_KEY_RATE_LIMIT_MAX: numberish(600)` (config/env.ts:326) — is chained from inside merchantAuth at middleware/auth.ts:157 `apiKeyRateLimiter(req, res, next);`, i.e. strictly after the global one has already run and possibly already answered 429. A later limiter cannot loosen an earlier one.

Keying: index.ts:29 `app.set('trust proxy', 1)` plus the Apache reverse proxy the deploy script writes (deploy-crypto-gateway.sh:363-384) means `req.ip` is the real client address. So a merchant integration calling from one or two server IPs is capped at 120/min, and the comment at rateLimit.ts:131-137 — which correctly explains why an IP key is wrong for merchant traffic — is defeated by the limiter mounted in front of it.

1,000 concurrent requests from any single source is 8x over the ceiling in the first second.

**Fix.** backend/src/middleware/rateLimit.ts:28-35 — make the global limiter a coarse abuse ceiling and let the purpose-built limiters do the real work:
```ts
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  passOnStoreError: true,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('rl:global:'),
  // Authenticated traffic is governed per-key by apiKeyRateLimiter (auth.ts:157)
  // and per-session by the dashboard limiters. Counting it here as well caps a
  // merchant's whole integration at one IP's worth of requests.
  skip: (req) => Boolean(req.headers['x-api-key'] || req.headers.authorization),
  message: { error: 'rate_limited', message: 'Too many requests' },
});
```
Then in backend/src/config/env.ts:320 raise the default to `RATE_LIMIT_MAX: numberish(3000)` — with the `skip` above it now only governs unauthenticated traffic, where the tight per-route limiters (checkoutReadLimiter 120/min at :75, checkoutWriteLimiter 10/min at :91, signupRateLimiter at :55, authRateLimiter at :38) are the actual protection. Size `API_KEY_RATE_LIMIT_MAX` (config/env.ts:326) against real target throughput and document it as the per-merchant ceiling.

### The settle tick's payout half is unbounded and its sweep half is capped at 500 oldest-first, so permanently unsweepable dust starves real settlements out of the safety net
`backend/src/workers/index.ts:203` — money — status: CONFIRMED

**Evidence.** Both halves verified. (a) workers/index.ts:203-209 is `SELECT id FROM payments WHERE status='confirmed' ORDER BY confirmed_at ASC NULLS FIRST LIMIT $1` with SETTLE_BATCH_LIMIT=500 (line 194). A payment below its asset's minSweep can never leave `confirmed`: evmAdapter.ts:338-344 returns null (`if (balanceU < toBaseUnits(asset.minSweep, asset))`), evmAdapter.ts:207-213 the same for natives, bitcoinAdapter.ts:186-193 the same for BTC — and processSweep at workers/index.ts:94-97 does `if (!result) return;` with NO status change. processExpiry (workers/index.ts:165-172) only touches `waiting`, so nothing else ever moves them. Ordered oldest-first, those rows permanently occupy the head of every batch. Ethereum's minSweep is '20' (assets.ts:129/138/147, ETH_MIN_SWEEP_AMOUNT default '20' at config/env.ts:105), so ANY ERC20 payment under 20 USDT is one of these — and nothing at creation prevents it (paymentService.ts:174 checks only `> 0`, never minSweep, despite `asset` being resolved 15 lines later at 189).

(b) The payout re-drive at workers/index.ts:222-243 has NO LIMIT and no ORDER BY, and each matched row runs a full requestPayout in a sequential `for` loop (244-258): a transaction (payoutService.ts:149), a pg_advisory_xact_lock (169-172), three sequential aggregates (468-485), an INSERT, an audit write and a BullMQ add. The settle worker is concurrency 1 (workers/index.ts:320-323), so once a pass exceeds 60s the ticks queue and the sweep half of the next pass never runs.

One correction to the auditor's exploit path: the public checkout write endpoint is rate-limited to 10/min per IP with a Redis store (middleware/rateLimit.ts:91-101), so '500 dust rows in a few minutes' overstates the hostile case. The mundane path is sufficient and does not need an attacker: ordinary sub-20-USDT Ethereum payments, plus every payment stuck by `commission-denominated-in-payment-asset` and `no-decimal-validation-against-asset`, accumulate into exactly this population. `capped: true` is emitted only as a log field (workers/index.ts:261-266), so nothing alerts.

**Fix.** (1) Reject unsettleable payments at creation. backend/src/services/paymentService.ts, after line 189: compare the resolved amount against `asset.minSweep` in BigInt and throw `AppError.badRequest` naming the minimum. A payment the gateway cannot settle should never be minted.
(2) Give dust a terminal state. The adapters currently return null for two different reasons — below-minimum (evmAdapter.ts:338, 207; bitcoinAdapter.ts:186) and deferred-by-gas-policy (evmAdapter.ts:352-357, bitcoinAdapter.ts:196) — and the worker cannot tell them apart. Change `SweepResult | null` to `SweepResult | { deferred: true } | { unsweepable: true, reason: string }` in blockchain/networks.ts:71-78 and, in workers/index.ts:94-97, set `status='unsweepable'` (new enum member) for the latter and stop re-enqueuing.
(3) Bound the payout half: add `ORDER BY confirmed_at ASC LIMIT $1` with SETTLE_BATCH_LIMIT to workers/index.ts:228-243, matching the sweep half, and run the loop with a small concurrency bound (e.g. p-limit 3) rather than fully sequentially.
(4) Make the batch fair rather than strictly oldest-first: add `settle_attempts INT NOT NULL DEFAULT 0` to payments in a new migration, increment it per attempt, and `ORDER BY settle_attempts ASC, confirmed_at ASC` so a permanently failing row cannot monopolise the head.
(5) Emit `capped` as a metric/alert, not just a log field (workers/index.ts:261-266). It is the single clearest early warning that settlement has stalled.

### Funds arriving at a deposit address after the payment confirms are swept into the central wallet but credited to nobody — they become withdrawable admin commission
`backend/src/workers/index.ts:98` — money — status: CONFIRMED

**Evidence.** Verified. recordIncoming only matches `status IN ('waiting','confirming','partial')` (evmListener.ts:187-196), so a transfer arriving after promotion falls through to recordUnexpectedDeposit (evmListener.ts:203-211), which writes an `unexpected_deposits` row and deliberately does not credit it (unexpectedDepositService.ts:112-130, header at 9-19). But the sweep is balance-based: evmAdapter.ts:332-334 `const balanceU = await tokenRead.balanceOf(depositAddress)` with the comment 'On-chain balance is the source of truth (not amount_received)', and the transfer at 400+ moves the full balance. bitcoinAdapter.ts:183-212 sweeps every UTXO the same way. So the late arrival is physically moved to central while amount_received still reflects only the earlier transfers.

The accounting consequence is exactly as described: workers/index.ts:101-116 writes one `direction='sweep'` row for the FULL balance, adminCommissionService.ts:79-84 sums it into `collected`, and no payout row is ever created for the excess so `clientOwed` (adminCommissionService.ts:85-90) does not offset it. The auditor's sequence checks out — requestPayout({amount: '600'}) fails the guard at payoutService.ts:182-187 (confirmed=500), workers/index.ts:153-158 logs 'auto payout skipped', and one minute later workers/index.ts:246-249 retries with `p.amount_received` = 500 and succeeds. The 100 stays in central as phantom commission, and the `unexpected_deposits` row remains status='detected' pointing at an address that is now empty, so claimForSweep (unexpectedDepositService.ts:215-226) would find nothing.

One thing the auditor understated: after the 30s address-refresh cycle (evmListener.ts:143-155, 783-787 — the watch set only holds waiting/confirming/partial payments), a confirmed payment's address drops out of `depositAddresses`, and the reconciler's queryFilter is scoped to `watched` (evmListener.ts:471-475). So a late arrival more than ~30s after confirmation is not even RECORDED in unexpected_deposits — it is swept into central with no ledger row at all. The invisible case is the common one.

**Fix.** Make the sweep reconcile what it actually moved. In backend/src/workers/index.ts, between the blockchain_transactions INSERT (line 101-116) and the status update (119-122):
(1) Compare in BigInt via `toAccountingUnits` (utils/money.ts): `const excess = toAccountingUnits(balanceHuman) - toAccountingUnits(payment.amount_received)`.
(2) When `excess > 0n`, resolve it against `unexpected_deposits` for that `(deposit_address, asset)`:
  UPDATE unexpected_deposits SET status='swept', sweep_tx_hash=$2, updated_at=now()
   WHERE lower(deposit_address)=lower($1) AND asset=$3 AND status IN ('detected','failed');
The `sweep_tx_hash` column already exists (migration 010_unexpected_deposits.sql). This stops the recovery ledger pointing at an empty address.
(3) Decide the credit explicitly rather than by omission. For an arrival whose asset MATCHES the payment's asset (a LATE PAYMENT — same customer, same invoice), raise the credit in the same statement:
  UPDATE payments SET amount_received = $2 WHERE id = $1 AND status='confirmed' AND amount_received < $2;
so the settle tick's `requestPayout({amount: p.amount_received})` settles the full 600. For a WRONG-ASSET arrival, leave the credit alone (correct today) but exclude that portion from `collected` in getCommissionBalance — otherwise it inflates the commission pool exactly as here.
(4) Log an ERROR (not a warn) whenever `excess != 0`, and add the same reconciliation to the Tron and Bitcoin sweep paths.
(5) Independently, keep a deposit address in the listener watch set for a grace window after confirmation (evmListener.ts:145-149: add `OR (status IN ('confirmed','swept') AND confirmed_at > now() - interval '1 hour')`) so late arrivals are at least SEEN.

### GET /api/v1/payouts returns every payout row a merchant has ever had — no LIMIT, no pagination
`backend/src/routes/payouts.ts:76` — scale-and-load — status: DOWNGRADED

**Evidence.** Verified verbatim at routes/payouts.ts:66-82: `SELECT id, gross_amount, status, to_address, network, asset, tx_hash, created_at FROM payouts WHERE client_id = $1 ORDER BY created_at DESC` with no LIMIT/OFFSET, then `res.status(200).json(rows.map(toClientPayout))`. The bounded-elsewhere claim checks out: paymentService.ts:350 `Math.min(100,...)`, invoiceService.ts:505 `Math.min(200,...)`, unexpectedDepositService.ts:190 `LIMIT 200`, account.ts:952 `LIMIT 100`. Index claim checks out: I grepped every CREATE INDEX in sql/schema.sql and sql/migrations/*.sql — payouts has only (client_id), (client_id,network,asset,status), (client_id,network,status), (status), (network). Nothing on (client_id, created_at), so the ORDER BY is a sort of the whole client slice.

DOWNGRADED, three corrections. (1) AUTO_PAYOUT_ENABLED is `boolish.default(false)` at config/env.ts:245, not on by default — the one-row-per-payment growth only holds where an operator enabled it. (2) The caller is the Payouts page (client-panel/src/pages/Payouts.tsx:39 `useQuery({queryKey:['payouts'], queryFn: listPayouts})`), not the dashboard on every load; Dashboard.tsx:525 only renders a link. (3) The OOM arithmetic is a multi-year projection, not weeks: ~250 bytes of JSON per row means V8's ~512 MB string ceiling needs >2M rows for one merchant, and 100k coins/day at any plausible average payment size is thousands of payments/day fleet-wide, not 10^4/day for one merchant. What is certain today: an unbounded response body, an external sort of the full client slice, and one of 20 pool connections held for the duration with no statement_timeout. That is high, not critical — it degrades badly and has a genuine OOM tail, but it does not crash and stay down at the stated load.

**Fix.** Paginate exactly like listPayments. In routes/payouts.ts GET '/': read `page`/`limit` from req.query, clamp with `const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 25)))`, and switch the SQL to keyset form: `WHERE client_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2, $3)) ORDER BY created_at DESC, id DESC LIMIT $4`, returning `{data, nextCursor}`. The client panel already tolerates this — client-panel/src/lib/api.ts:443 types the response as `Payout[] | Paginated<Payout>` and unwraps `data.data` — so a paginated envelope is not a breaking change. Add the migration `CREATE INDEX CONCURRENTLY idx_payouts_client_created ON payouts (client_id, created_at DESC, id DESC);`

### The listener rewrites every pending blockchain_transactions row twice every 5 seconds, with no index to find them
`backend/src/blockchain/evmListener.ts:583` — scale-and-load — status: DOWNGRADED

**Evidence.** The scan half is confirmed exactly as described. evmListener.ts:583-591: `UPDATE blockchain_transactions SET confirmations = GREATEST(0, $1 - block_number) WHERE direction = 'incoming' AND status = 'pending' AND network = '${cfg.network}' AND block_number IS NOT NULL` — no row bound. Called at evmListener.ts:449 and again at :512 inside one reconcileOnce, plus :563 in the native pass, on RECONCILE_INTERVAL_MS = 5_000 (evmListener.ts:96). Same statement at tronListener.ts:408-416 and bitcoinListener.ts:159-167. Schema confirms the index set is exactly idx_btx_payment, idx_btx_to, idx_btx_block, idx_btx_network, idx_btx_network_asset plus UNIQUE(tx_hash,log_index) (sql/schema.sql:566-570) — nothing on (direction,status), and `network` is single-valued per deployment, so the driving predicate has no usable index.

DOWNGRADED because the write-amplification half is refuted. (a) The set of matching rows is bounded by in-flight payments, not by table size: recordIncoming only matches payments in waiting/confirming/partial (evmListener.ts:190) and promotion flips the rows to 'confirmed' at evmListener.ts:631-637. (b) The cited immortal-row mechanism does not exist — detectReorgs sets those rows to 'reorged' (evmListener.ts:702-705), which the `status = 'pending'` predicate excludes. (c) I grepped the whole tree: no code path ever writes payments.status='partial', so there is no stuck-partial accumulation either. (d) The payments mirror UPDATE at evmListener.ts:594-604 is driven by `p.status='confirming'`, a small slice reachable via idx_payments_status → idx_btx_payment, so it is not the worse of the two. So autovacuum is not the failure mode; the failure mode is a growing full-table sequential scan run 3x per 5 s forever on a table that is never pruned.

**Fix.** (1) Migration: `CREATE INDEX CONCURRENTLY idx_btx_pending_incoming ON blockchain_transactions (network, block_number) WHERE direction = 'incoming' AND status = 'pending';` — that alone converts all three listeners' driving predicate from a seq scan to an index scan over the in-flight set. (2) Call updateConfirmationsAndPromote once per reconcileOnce, not twice: delete the call at evmListener.ts:449 and keep the one at :512 (it already runs after the scan, so it sees everything the earlier call would have). (3) Bound the statement to rows that can still move by adding `AND block_number > $1 - $2` with $2 = required_confirmations + cfg.reorgDepth. Mirror all three changes in tronListener.ts:408 and bitcoinListener.ts:159.

### Pool max is 20 per process with a 10s acquire timeout and no statement_timeout — one slow query takes the whole instance down, /health included
`backend/src/db/pool.ts:16` — scale-and-load — status: CONFIRMED

**Evidence.** db/pool.ts:14-19 is exactly `new Pool({ connectionString, max: 20, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })`. I grepped backend/src, backend/*.json and docker-compose.yml for statement_timeout, idle_in_transaction_session_timeout, lock_timeout, DB_POOL and POOL_MAX — zero hits anywhere. Confirmed there is exactly one `Promise.all` across all of routes/ and services/ (adminCommissionService.ts:117). Auth pool dependency confirmed: middleware/auth.ts:168 and :179 both go through `query()` before any route body runs, so pool saturation fails authentication itself. Error mapping confirmed: a pg 'timeout exceeded when trying to connect' is a plain Error, not an AppError or ZodError and not code 23505, so it falls through to utils/apiError.ts:97-98 and returns a bare 500 after a 10 s hang. /health (index.ts:60-62) does no DB work, so the probe stays green while every real request fails. POST /payments acquisition count verified as 5: auth SELECT (auth.ts:168), fire-and-forget last_used_at UPDATE (auth.ts:149), the createPayment transaction (paymentService.ts:291), and enqueueWebhook's two statements (webhookService.ts:82, :145); the idempotency middleware is Redis-only so it adds none.

One fact the finding missed that strengthens it: max:20 is per process with no env override, so `--scale api=4` plus 3 workers plus 4 listeners is 220 potential backend connections against Postgres's default max_connections=100. The fleet cannot be scaled without either PgBouncer or a tuned server.

**Fix.** In db/pool.ts:14-19 replace the literal options with: `max: Number(process.env.DB_POOL_MAX ?? 20), connectionTimeoutMillis: 2_000, idleTimeoutMillis: 30_000, statement_timeout: 15_000, idle_in_transaction_session_timeout: 30_000` (node-pg forwards statement_timeout and idle_in_transaction_session_timeout to the server as startup parameters). Export a second `readPool` with `statement_timeout: 5_000` and point routes/admin.ts's analytics and wallet handlers at it so an operator dashboard can never starve the money path. Put PgBouncer in transaction-pooling mode in front so pool_size x replicas is decoupled from max_connections. In utils/apiError.ts, before the generic 500 at line 97, add: `if (err instanceof Error && /timeout exceeded when trying to connect/.test(err.message)) { res.set('Retry-After','1'); res.status(503).json({error:'service_unavailable', message:'Database is saturated; retry shortly'}); return; }`. Separately, `Promise.all` the four independent aggregates in routes/account.ts:753-875.

### Every payment creation in the fleet serialises on one hd_counter row, and holds that row lock across a 3.4 ms synchronous key derivation
`backend/src/services/paymentService.ts:239` — scale-and-load — status: CONFIRMED

**Evidence.** paymentService.ts:239 `const index = await getNextDerivationIndex(client)` is inside the transaction body passed to withTransaction at :291. utils/hdwallet.ts:51-56 is `UPDATE hd_counter SET next_index = next_index + 1 WHERE id = 1 RETURNING next_index - 1`, and sql/schema.sql:252-256 confirms hd_counter is a single row (`id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`) shared by every merchant and every network — the schema comment at :250-251 says so explicitly. The row-level exclusive lock is therefore held from that UPDATE until COMMIT, across `adapter.deriveDeposit(index)` (paymentService.ts:240 -> evmAdapter.ts:272-279 -> hdwallet.ts:68-77), the wallets INSERT (:243), the payments INSERT (:252) and the WAL commit. hdwallet.ts:26-30 calls `Mnemonic.fromPhrase` + `HDNodeWallet.fromMnemonic` on EVERY call, and it is fully synchronous. utils/tronHdwallet.ts:44 has the identical defect (`TronWeb.fromMnemonic(config.hd.mnemonic.trim(), path)` per call).

I reproduced the measurement with the project's own ethers 6 on this machine: full deriveAddress 3.428 ms/call, cached-root derivePath 1.367 ms/call, seed+root construction alone 2.038 ms/call. So the auditor's numbers are accurate and 60% of the cost is avoidable. The critical section is therefore ~5-10 ms of fleet-wide-serialised work, of which 3.4 ms is synchronous event-loop burn in whichever process holds the lock. Ceiling is ~100-200 payment creations/second fleet-wide regardless of replica count. Note this ceiling is ~100x the steady-state arrival rate at 100k coins/day — the finding is real specifically for the stated 1000-concurrent burst, where the queue drains in 5-10 s and everything past the 10 s connectionTimeoutMillis 500s. The hosted-checkout compounding is real: routes/paymentLinks.ts:170-210 opens a transaction, claimLinkUse takes the link row lock, then createPayment queues on the global counter while still holding it.

**Fix.** Two independent changes. (1) Memoise the root in utils/hdwallet.ts: replace rootFromMnemonic's body with a lazy module singleton — `let cachedRoot: HDNodeWallet | null = null; function rootFromMnemonic(): HDNodeWallet { if (!cachedRoot) cachedRoot = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(config.hd.mnemonic.trim())); return cachedRoot; }`. Measured effect: 3.428 ms -> 1.367 ms per derivation. Do the same for the TronWeb account in utils/tronHdwallet.ts:44 (cache per derivation path, or cache the seed and derive with a BIP32 lib). (2) Get both the index and the derivation out of the transaction. Add `CREATE SEQUENCE IF NOT EXISTS hd_index_seq;` seeded from `(SELECT next_index FROM hd_counter WHERE id=1)`, change getNextDerivationIndex to `SELECT nextval('hd_index_seq')` (sequences take no transactional lock and never block), and in paymentService.ts hoist BOTH the index reservation and `adapter.deriveDeposit(index)` to above the `const body = async (client) => {...}` closure so no lock is ever held across CPU work. A burned index on a rolled-back transaction is harmless — the codebase already accepts that at paymentService.ts:191-194 for the fiat-quote path.

### The global limiter is 120 requests/minute per IP and is applied to every request including /health — the stated load cannot get through it
`backend/src/index.ts:57` — scale-and-load — status: CONFIRMED

**Evidence.** index.ts:57 `app.use(globalRateLimiter)` sits above `app.get('/health', ...)` at :60 and above `app.use('/api/v1', buildRouter())` at :68 — verified by reading the file top to bottom. middleware/rateLimit.ts:28-35 configures it with `windowMs: config.rateLimit.windowMs, max: config.rateLimit.max` and supplies NO keyGenerator, so express-rate-limit 7.5.1's default IP key applies. config/env.ts:319-320 defaults are `RATE_LIMIT_WINDOW_MS: numberish(60000)` and `RATE_LIMIT_MAX: numberish(120)` — 2 requests/second per IP. index.ts:29 `app.set('trust proxy', 1)` makes the key the forwarded client IP. The per-key limiter that IS correctly sized (API_KEY_RATE_LIMIT_MAX default 600, config/env.ts:326) and correctly keyed (`keyGenerator: (req) => req.client?.apiKeyId ?? ...`, rateLimit.ts:145) runs only after merchantAuth populates req.client (auth.ts:157), so it cannot rescue anything the global limiter already 429'd. This is the most direct answer to 'will 1000 concurrent requests work': no — at most 120 per IP per minute get through, the rest receive `{error:'rate_limited'}` (rateLimit.ts:34). The /health interaction is real as written: the probe shares the node IP's bucket with all other traffic from that address, and nothing exempts it.

**Fix.** In index.ts, move the `app.get('/health', ...)` registration from line 60 to immediately BEFORE `app.use(globalRateLimiter)` at line 57 (belt and braces: also add `skip: (req) => req.path === '/health'` to globalRateLimiter in middleware/rateLimit.ts:28). Give globalRateLimiter an explicit key that prefers the authenticated principal so a merchant behind one egress IP is never throttled as an anonymous visitor: `keyGenerator: (req) => req.client?.apiKeyId ?? req.client?.clientId ?? ipKeyGenerator(req)` (import ipKeyGenerator from express-rate-limit so IPv6 is normalised). Raise RATE_LIMIT_MAX to a per-IP anti-abuse floor (e.g. 1200/min) and let API_KEY_RATE_LIMIT_MAX be the real business ceiling. Set `app.set('trust proxy', <actual hop count>)` at index.ts:29 to match the deployed proxy chain — the literal 1 is wrong the moment there are two proxies, and a wrong hop count makes the IP key spoofable.

### A Redis error 500s every HTTP request, /health included, because the rate-limit store does not pass on store errors
`backend/src/middleware/rateLimit.ts:13` — scale-and-load — status: CONFIRMED

**Evidence.** I read the installed source. node_modules/express-rate-limit/package.json is version 7.5.1; dist/index.cjs:671 sets `passOnStoreError: false` as the default, and :712-726 reads `try { await config.store.increment(key) } catch (error) { if (config.passOnStoreError) { ...next(); return; } throw error; }`. That throw is inside `handleAsyncErrors` (dist/index.cjs:689-695) which does `.catch(next)`, so it becomes `next(error)`. In this app that reaches utils/apiError.ts:97-98 — not an AppError, not a ZodError, not code 23505 — and returns a bare 500. middleware/rateLimit.ts:13-25 confirms the try/catch wraps only `new RedisStore({...})` construction; the runtime `redis.call(command, ...args)` at :17-18 is inside the sendCommand callback and is not covered. Because globalRateLimiter is mounted at index.ts:57 ahead of everything, this applies to every route in the process including GET /health. db/redis.ts:13-16 confirms `new IORedis(config.redisUrl, { maxRetriesPerRequest: 3, enableReadyCheck: true })` — enableOfflineQueue is left at its default true, so commands pile into an unbounded in-memory queue during a reconnect and then reject after 3 retries. index.ts:94 does call scheduleExpiryJob at boot on every API instance, so a restart storm does add Redis load.

**Fix.** Add `passOnStoreError: true` to globalRateLimiter (rateLimit.ts:28-35), apiKeyRateLimiter (:139-151), checkoutReadLimiter (:75) and invoiceSendLimiter (:116) — a brief unmetered window is strictly better than a total outage. Leave it false on authRateLimiter (:38) and signupRateLimiter (:55) where failing open is a real abuse risk, and give those two an in-memory fallback store so they still function: build them with `store: buildStore('rl:auth:') ?? undefined` (undefined already selects the in-memory store) and add a Redis health probe that swaps them over. Exempt /health from the limiter entirely (see the previous finding). In db/redis.ts:13, add `enableOfflineQueue: false` and `commandTimeout: 2000` so commands fail fast instead of queueing unbounded during a reconnect.

### Every balance read sums the merchant's entire payment and payout history — and it runs inside the payout advisory lock
`backend/src/services/payoutService.ts:468` — scale-and-load — status: CONFIRMED

**Evidence.** payoutService.ts:468-485 confirmed verbatim: three separate `await one(...)` calls — `SUM(amount_received) FROM payments WHERE client_id=$1 AND status IN ('confirmed','swept')`, `SUM(amount) FROM payments WHERE ... IN ('waiting','confirming','partial')`, `SUM(gross_amount) FROM payouts WHERE ... IN ('pending','processing','sent','confirmed')`. No date bound on any of them. The lock interaction is exactly as described: payoutService.ts:169-172 takes `SELECT pg_advisory_xact_lock($1, hashtext($2))` keyed on `${clientId}:${network}`, and getBalanceWith is then called at :176-181 on the transaction's own connection, so the lock is held across all three aggregates until COMMIT at :230. Hot-path callers confirmed: workers/index.ts:140-151 after every sweep, and workers/index.ts:246 from the 60-second settle tick.

One refinement to the mechanism: the aggregates are NOT seq scans. sql/schema.sql:366-367 has `idx_payments_client_network_asset_status ON payments(client_id, network, asset, status)` and :664-666 the payouts equivalent, and requestPayout passes both network and asset, so the leading columns match exactly. They are index scans — but `amount_received`, `amount` and `gross_amount` are in no index, so every matching row still takes a heap fetch, and the matching row count is the merchant's entire lifetime confirmed/swept history and grows without bound. The schema comments at :365 and :667 show the authors knew this read sits under the lock; the covering columns are the piece that was missed.

**Fix.** Immediate mitigation (safe, no schema change to the ledger): collapse the three statements in payoutService.ts:463-485 into one so the lock covers one round trip instead of three — `SELECT COALESCE(SUM(p.amount_received) FILTER (WHERE p.status IN ('confirmed','swept')),0)::text AS confirmed, COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('waiting','confirming','partial')),0)::text AS pending FROM payments p WHERE p.client_id=$1 ...` plus one payouts statement. Then make both index-only scans: `CREATE INDEX CONCURRENTLY idx_payments_bal ON payments (client_id, network, asset, status) INCLUDE (amount_received, amount);` and `CREATE INDEX CONCURRENTLY idx_payouts_bal ON payouts (client_id, network, asset, status) INCLUDE (gross_amount);` Real fix: add a `client_balances (client_id, network, asset, confirmed_total, paid_out_total)` table updated in the same transactions that write the underlying rows — the payment confirmation at evmListener.ts:621-627 and the payout INSERT at payoutService.ts:189 — so the guard reads one indexed row under the lock. Keep the existing aggregates as a nightly reconciliation job that asserts the materialised figures still equal history and alerts on drift.

### The settle tick re-scans every swept payment ever, every 60 seconds, anti-joined against payouts with no index on payouts.payment_id
`backend/src/workers/index.ts:228` — scale-and-load — status: CONFIRMED

**Evidence.** workers/index.ts:222-243 confirmed: the step-2 query has no LIMIT and no date bound, ending in `AND NOT EXISTS (SELECT 1 FROM payouts po WHERE po.payment_id = p.id AND po.status IN ('pending','processing','sent','confirmed'))`. Step 1 directly above it at :203-209 IS bounded — `ORDER BY confirmed_at ASC NULLS FIRST LIMIT $1` with SETTLE_BATCH_LIMIT = 500 (:194) — and the comment at :198-202 explains precisely why an unbounded version was wrong. Step 2 kept the defect. The schedule is `repeat: { every: 60_000 }` (queues.ts:113). Two compounding facts I verified: payment_status is an ENUM whose terminal successful value is 'swept' (sql/schema.sql:30) and nothing in the codebase ever transitions a payment out of 'swept' (grep confirms workers/index.ts:120 is the only write of it), so `p.status='swept'` selects essentially the whole successful history forever; and there is NO index on payouts(payment_id) anywhere in sql/schema.sql:663-670 or any of the 21 migrations, so the anti-join must build a hash over the whole payouts table. The loop at :244-258 then calls requestPayout once per row, dragging in the three growing aggregates and the advisory lock from the previous finding. The permanently-failed-payout re-entry is real: payout_status includes 'failed' (schema.sql:33) and it is deliberately excluded from the NOT EXISTS list, with payoutService.ts:478-480 explaining why.

**Fix.** Bound step 2 the same way step 1 already is. Append to the query at workers/index.ts:228-243: `AND p.updated_at > now() - interval '7 days' ORDER BY p.updated_at ASC LIMIT $1` and pass `[SETTLE_BATCH_LIMIT]`. Anything older than the window is an operator problem, not a retry-loop problem. Add the migrations `CREATE INDEX CONCURRENTLY idx_payouts_payment ON payouts (payment_id) WHERE payment_id IS NOT NULL;` and `CREATE INDEX CONCURRENTLY idx_payments_swept ON payments (updated_at) WHERE status = 'swept';` Then add a `settle_attempts INT NOT NULL DEFAULT 0` column on payments, increment it in the catch at :254-257, and park rows past a threshold in a `needs_attention` state surfaced to an operator — the exact pattern services/subscriptionService.ts:370-384 already uses for missed billing cycles.

### eth_getLogs is filtered by an unbounded array of every watched deposit address; when the RPC rejects it the cursor never advances
`backend/src/blockchain/evmListener.ts:471` — scale-and-load — status: CONFIRMED

**Evidence.** evmListener.ts:471 `const watched = Array.from(depositAddresses);` then :475 `const filter = token.filters.Transfer(null, watched);` and :478 `token.queryFilter(filter, fromBlock, scanTo)` — once per enabled asset, every 5 s, with MAX_SCAN_RANGE = 2_000 (:99). The watch set is unbounded: refreshDepositAddresses at :143-149 is `SELECT DISTINCT deposit_address FROM payments WHERE status IN ('waiting','confirming','partial') AND network = '...'` with no LIMIT. The wedge is real and is the strongest part: the catch at :479-485 logs and `return`s from reconcileOnce entirely, so chain_cursor.last_scanned_block (:513-516) is never advanced and the identical oversized request is reissued every 5 s forever, with nothing distinguishing a permanent failure from a transient one in the logs.

One correction to the stated impact, which does not change the verdict. 'Confirmations stop advancing for every payment on the chain' is wrong: updateConfirmationsAndPromote(head) already ran at evmListener.ts:449, BEFORE the scan, so confirmations, promotion to 'confirmed', the confirmed webhook and the sweep enqueue all keep working on every pass. What actually stops is missed-event DISCOVERY — the polling reconciler is the source of truth per the file header at :27-33, and the WS fast path at :299-387 is documented at :24-25 as best-effort and able to drop events. So the failure is: a deposit the WS missed is never recorded, the payment stays 'waiting' until it expires, and the customer's funds sit at a derivable HD address with nobody credited.

**Fix.** In evmListener.ts:466-509, chunk the topic set and only advance on full success. Replace the per-asset body with: `const CHUNK = 200; let allOk = true; for (const asset of tokenAssetsFor(cfg.network)) { const token = tokenContract(httpRpc, asset); for (let i = 0; i < watched.length; i += CHUNK) { const batch = watched.slice(i, i + CHUNK); try { logs = await token.queryFilter(token.filters.Transfer(null, batch), fromBlock, scanTo); } catch (err) { logger.error({err, asset: asset.symbol, batchStart: i}, 'queryFilter batch failed'); allOk = false; continue; } ...process... } }` and guard the cursor UPDATE at :513 with `if (!allOk) return;`. Add a module-level `let staleP asses = 0` incremented whenever the cursor does not advance and reset when it does, and log at error level with a distinct message once it exceeds 12 (one minute) so a permanently wedged reconciler is visibly different from a transient one. Also bound the watch set at :143-149 with `AND expires_at > now() - interval '1 hour'` so a stalled expiry worker cannot grow it without limit.

### Six hot-path predicates have no supporting index; the exact CREATE INDEX statements are missing from the schema
`sql/schema.sql:356` — scale-and-load — status: CONFIRMED

**Evidence.** I enumerated every CREATE INDEX in sql/schema.sql and all 21 files in sql/migrations/ and checked each claim. (Path correction: the schema is at sql/schema.sql at the repo root, not backend/sql/schema.sql.) All six are genuinely absent. (1) payments(client_id, status, created_at DESC) — the only client-leading indexes are idx_payments_client (client_id), idx_payments_client_created (client_id, created_at DESC), idx_payments_client_network_asset_status (client_id, network, asset, status) and idx_payments_client_network_status; none serves paymentService.ts:353-372's client_id + status filter with a created_at sort without reading the whole client slice. (2) payouts(client_id, created_at DESC) — payouts has only (client_id) plus three network-leading composites (schema.sql:663-670). (3) payouts(payment_id) — absent everywhere; backs the once-a-minute anti-join at workers/index.ts:238-242. (4) payouts(created_at DESC) — absent; admin.ts:570 orders the whole table by it. (5) webhook_logs(created_at DESC) — absent; idx_webhook_logs_client is (client_id, created_at DESC) (schema.sql:723) and cannot serve admin.ts:687's unfiltered ORDER BY. (6) the btx partial index — absent, per the btx-hot-update finding. The idx_payments_status remark is also correct: payment_status is a 7-value ENUM (schema.sql:30) and 'swept' is the terminal state of every successful payment, so a plain index on it is near-useless for the very lookups workers/index.ts:205 and :231 perform.

**Fix.** One migration, everything CONCURRENTLY (so run it outside a transaction block — no BEGIN/COMMIT in the file):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_client_status_created ON payments (client_id, status, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_client_created ON payouts (client_id, created_at DESC, id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_payment ON payouts (payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_created ON payouts (created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_logs_created ON webhook_logs (created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_btx_pending_incoming ON blockchain_transactions (network, block_number) WHERE direction = 'incoming' AND status = 'pending';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_confirmed ON payments (confirmed_at) WHERE status = 'confirmed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payments_swept ON payments (updated_at) WHERE status = 'swept';
DROP INDEX CONCURRENTLY IF EXISTS idx_payments_status;
Then ANALYZE payments, payouts, blockchain_transactions, webhook_logs.

### Admin endpoints run unfiltered COUNT(*) and full-table SUM aggregates over payments and payouts on every page load
`backend/src/routes/admin.ts:471` — scale-and-load — status: CONFIRMED

**Evidence.** All four offenders verified in the source. (1) `SELECT COUNT(*)::text AS count FROM payments p WHERE 1=1` at admin.ts:470-473, the payouts equivalent at :546-550 and webhook_logs at :675-679 — all reached with no filter when the operator does not pass clientId/status. (2) walletBalancesHandler at admin.ts:710-723 runs `SELECT c.id, c.business_name, p.network, COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('waiting','confirming')),0) FROM clients c JOIN payments p ON p.client_id = c.id GROUP BY c.id, c.business_name, p.network HAVING ...` with no WHERE clause at all — a full scan and hash-aggregate of the entire payments table, served at both /admin/wallets and /admin/wallets/balances. (3) /admin/analytics at admin.ts:779-791 is seven unfiltered scalar subqueries over payments and payouts, and :842-856 and :870-884 aggregate both tables in full again via uncorrelated derived tables. (4) adminClientService.ts:118-132 CLIENT_SELECT — the LATERAL pattern IS used correctly for `ak` and `com` at :108-117, but `vol`, `pend` and `po` are plain uncorrelated `SELECT client_id, SUM(...) ... GROUP BY client_id` subqueries LEFT JOINed on client_id. Postgres cannot push `c.id = $1` into them: for an outer join the ON-clause equality does not form an equivalence class usable to constrain the nullable side, and qual pushdown into a grouped subquery requires a qual on the subquery's own output, not a join clause. So getAdminClient(clientId) at :179-182 — fetching ONE merchant, called after every admin mutation e.g. admin.ts:442 — aggregates the whole payments and payouts tables. None of these is cached, none has a date bound, and each holds one of 20 connections (db/pool.ts:16) with no statement_timeout to cut it off.

By contrast routes/account.ts's merchant analytics IS correctly bounded (`created_at >= win.prev_start_at` at :806, `>= now() - make_interval(...)` at :816/:830), so this is an admin-surface problem specifically.

**Fix.** (1) In adminClientService.ts:118-132, convert the three derived tables to LATERAL, matching the pattern the same file already uses at :108-117: `LEFT JOIN LATERAL (SELECT SUM(amount_received) AS volume FROM payments WHERE client_id = c.id AND status IN ('confirmed','swept')) vol ON true` and likewise for pend and po. That makes getAdminClient touch only one merchant's rows and makes the list page cost proportional to the page size. (2) Bound admin.ts:710-723 with `WHERE p.status IN ('waiting','confirming') AND p.created_at >= now() - interval '30 days'` before the GROUP BY (it is already partial-index-backed by idx_payments_expires) and drop the HAVING. (3) Replace the three unfiltered COUNT(*) calls at :470, :546 and :675 with keyset pagination, or when no filter is present return `(SELECT reltuples::bigint FROM pg_class WHERE relname='payments')` as an explicit `totalApprox`. (4) Move /admin/analytics onto a materialized view refreshed every 5 minutes by the settle worker — it is a dashboard, not a ledger — and in the interim run it on the separate read pool with statement_timeout 5000 from the pg-pool fix.

### POST /payments burns ~5.2 ms of synchronous, event-loop-blocking CPU per request (HD derivation + QR), and bcryptjs at cost 12 blocks for ~200 ms per login
`backend/src/utils/hdwallet.ts:26` — scale-and-load — status: CONFIRMED

**Evidence.** All three sinks verified in source and all three measurements independently reproduced with the project's own node_modules on this machine. (1) hdwallet.ts:26-30 re-runs `Mnemonic.fromPhrase` + `HDNodeWallet.fromMnemonic` on every deriveAddress (:70) and derivePrivateKey (:85) call — measured 3.428 ms/call end to end, of which 2.038 ms is the seed construction alone, versus 1.367 ms with the root cached. (2) paymentService.ts:302 `await QRCode.toDataURL(adapter.paymentUri(...))` on every POST /payments and again at :329 on every GET /payments/:id for waiting/confirming payments — measured 1.760 ms/call. Total ~5.2 ms confirmed. (3) package.json:30 pins `bcryptjs ^2.4.3` (pure JS, no native binding) and cost 12 is used at routes/auth.ts:64 (login compare), account.ts:460/463, register.ts:150/421, admin.ts:149/304. Measured `bcrypt.compare` at cost 12 = 200.3 ms. I then measured 5 concurrent async compares: 1024 ms wall clock, during which a 5 ms setInterval fired only 3 times with a maximum gap of 505 ms — bcryptjs's setImmediate chunking does not meaningfully yield at this cost, exactly as claimed. authRateLimiter allows `Math.max(5, Math.floor(120/12))` = 10 attempts/minute per IP (rateLimit.ts:40), so the DoS amplification is real and it is per IP.

**Fix.** (1) Memoise the HD root as described in the hd-counter fix — one line, removes 60% of derivation cost, and also fixes the sweep path (derivePrivateKey at hdwallet.ts:85). Same for utils/tronHdwallet.ts:44. (2) Take QR generation off the request path: paymentService.ts already computes the URI at :303, so add `paymentUri` to PaymentDTO (toDTO at :380-413) and delete the `QRCode.toDataURL` calls at :302 and :329, letting the checkout page render client-side. If a server-rendered QR must stay, add `GET /payments/:id/qr` backed by a Redis cache keyed on sha256(uri) with a long TTL — the URI is immutable for a payment's lifetime. (3) Replace bcryptjs with a KDF that runs off-loop: `npm rm bcryptjs @types/bcryptjs && npm i @node-rs/argon2`, then `await argon2.verify(hash, password)` at auth.ts:64 and account.ts:460, `await argon2.hash(password)` at the six hash sites, with a one-time migration that re-hashes on next successful login (detect the `$2a$`/`$2b$` prefix and fall back to bcryptjs for legacy rows). Native `bcrypt` is the smaller-diff alternative — both run on libuv's threadpool and do not block the loop. Also set UV_THREADPOOL_SIZE to at least the pool max and export an event-loop-lag gauge (perf_hooks monitorEventLoopDelay) so this class of regression is visible.


## MEDIUM

### MFA has no enrollment path anywhere, while two middleware comments cite it as a control that protects money-moving routes
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/routes/auth.ts:72` — authsec — status: DOWNGRADED

**Evidence.** Factually correct. sql/schema.sql users declares `mfa_enabled BOOLEAN NOT NULL DEFAULT false` and `mfa_secret TEXT`; they are READ at routes/auth.ts:50 and verified at auth.ts:72-90, and redacted in config/logger.ts:26 — and that is the complete set of references. Grepping the whole repo (backend, admin-panel, client-panel, sql, docs) for mfa turns up no INSERT or UPDATE touching either column, no /auth/mfa/* route, nothing in account.ts, admin.ts or seed.ts. admin-panel/src/pages/Login.tsx:134-158 renders an MFA field that the server can never demand. The two sub-defects are real but latent: speakeasy.totp.verify with `window: 1` and no used-code cache (auth.ts:79-84) allows unlimited replay of one code for ~90s, and the guard at auth.ts:88-90 only throws for `isAdmin`, so a merchant row with mfa_enabled=true and mfa_secret=NULL would log in with no second factor — both unreachable today precisely because nothing writes the columns. Downgraded from high because this is an ABSENT control, not a bypassed one: nothing that exists is defeated, no money moves wrongly, and password auth behaves as coded. The genuine defect is that middleware/clientAuth.ts:118 ('a human at a keyboard, holding a short-lived access token, past login and MFA') and middleware/auth.ts:264-265 invite an operator to size their threat model around something that is not there.

**Fix.** Either build it or stop claiming it; do the comment fix today regardless — reword clientAuth.ts:118 and auth.ts:264-265 to say 'past login' and drop 'and MFA'. To build it: add three routes behind requireDashboardSession in backend/src/routes/account.ts — POST /account/mfa/enroll (speakeasy.generateSecret, return otpauth_url, store `encrypt(secret)` into users.mfa_secret, leave mfa_enabled=false), POST /account/mfa/confirm (verify one token, then `UPDATE users SET mfa_enabled = true`), POST /account/mfa/disable (require current password + a live token). Add the admin equivalent under jwtAuth in routes/admin.ts. Then make it mandatory for non-merchant roles: at routes/auth.ts:69-90 replace the else-if with `if (!user.mfa_enabled || !user.mfa_secret) { if (isAdmin) throw AppError.unauthorized('MFA enrollment required'); } else { ...verify... }` — this also closes the merchant fall-through by testing the secret before the isAdmin branch. Add TOTP replay protection after a successful verify: `redis.set(`mfa:used:${user.id}:${mfaToken}`, '1', 'EX', 120, 'NX')` and reject when it returns null.

### Every authenticated API request fires an UPDATE against one api_keys row and takes a second connection from a 20-slot pool
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/auth.ts:149` — authsec — status: CONFIRMED

**Evidence.** middleware/auth.ts:149-151 runs `UPDATE api_keys SET last_used_at = now() WHERE id = $1` on every successful authentication, fire-and-forget with a .catch. db/pool.ts:14-19 configures `max: 20` and `connectionTimeoutMillis: 10_000`, and db/pool.ts:32 uses `pool.query(...)`, which checks a client out and releases it per statement — so each merchant request costs two pool checkouts before the handler asks for its own (the KEY_SELECT lookup at auth.ts:168 or 179, then this write). A failed auth costs two SELECTs for the same reason (auth.ts:116-118). One correction to the auditor's mechanics: each UPDATE is its own autocommit transaction, so the row lock is held only for the duration of the statement — the 'Nth request waits behind N-1 lock acquisitions' is a queue of sub-millisecond statements, not a stall, and it will not by itself exhaust the pool. The costs that are real are (a) doubling the per-request connection checkouts against a 20-slot pool at 1,000 concurrent, where the pool is already the binding constraint, and (b) one dead tuple per request on a tiny, extremely hot table, which turns autovacuum on api_keys into a foreground concern nobody planned for.

**Fix.** backend/src/middleware/auth.ts:149-151 — stop writing per request. Either (cheap) gate it so at most one write per key per minute survives: `UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`; or (better) `redis.set('keyseen:' + row.api_key_id, Date.now())` here and flush to Postgres from a BullMQ repeatable job in backend/src/workers/index.ts every 60s — the column feeds a dashboard timestamp (listApiKeys -> account.ts:125), never a security decision. Cache the auth lookup itself: key on sha256 of the presented credential, `redis.get`/`setex` for 5-10s, so the KEY_SELECT stops hitting Postgres on every request too (invalidate on revokeApiKey and on the PUT /account/settings ip_whitelist write). Independently, raise `max` in backend/src/db/pool.ts:14 to a value derived from Postgres max_connections divided by (api instances + worker instances) — 20 across all processes is the single largest ceiling on the stated 1,000-concurrent target — and add `statement_timeout: 5000` to the pool options so a slow query cannot hold a slot for the full 10s connect timeout.

### req.user is never populated on merchant routes, so the new-API-key security email cannot send and every merchant audit row records a NULL actor
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/clientAuth.ts:56` — authsec — status: DOWNGRADED

**Evidence.** Verified exactly. `req.user =` appears once in the entire tree, at middleware/jwtAuth.ts:51, and jwtAuth is mounted only on the admin router (`router.use(jwtAuth)` at routes/admin.ts:55). middleware/clientAuth.ts:70-79 sets req.client and nothing else, even on the dashboard-JWT branch where the decoded `{ sub, role, email }` is already in hand at clientAuth.ts:47. So `if (req.user?.email)` at routes/account.ts:180 is permanently false and sendApiKeyCreatedEmail (imported at account.ts:46, called only at account.ts:181) is dead code. The actorUserId call sites always write NULL while auditService.ts:29-31 stamps actor_type='user' — 12 of them, not 14: account.ts:164, 215, 254, 377, 695; invoices.ts:95, 130, 153; paymentLinks.ts:105, 130; subscriptions.ts:72, 133. sql/schema.sql audit_logs.actor_user_id is nullable, so nothing rejects the write. Downgraded from high: no money moves wrongly, nothing is credited to the wrong merchant, and no auth is bypassed — the client_id scoping on every one of these routes comes from req.client, which is set correctly. What is lost is a security notification that can never fire and a forensic column that is unconditionally NULL, i.e. observability class.

**Fix.** One line fixes all thirteen sites: in backend/src/middleware/clientAuth.ts, immediately after the role check at line 54-56 and before the client lookup, add `req.user = { userId: decoded.sub, role: decoded.role, email: decoded.email };`. Then make the notification independent of auth mode, since an API-key-authenticated key creation is not currently possible (requireDashboardSession) but the invoice/link/subscription audit rows are: in routes/account.ts:180, fall back to the owner's address — `const owner = await queryOne<{email:string}>('SELECT u.email FROM clients c JOIN users u ON u.id = c.user_id WHERE c.id = $1', [client.clientId])` — and send to `req.user?.email ?? owner?.email`. Add a regression test that POSTs /account/api-keys with a merchant JWT and asserts both a non-null audit_logs.actor_user_id and one sendApiKeyCreatedEmail call, because this bug is invisible without one.

### Tron listener issues O(addresses x assets) sequential HTTP calls per 5s pass with no concurrency and no time budget
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/tronListener.ts:493` — blockchain — status: DOWNGRADED

**Evidence.** The mechanism is exactly as described. tronListener.ts:493-531 is a plain `for (const [address, sinceMs] of depositAddresses)` with `await fetchInboundNative` (line 500) plus `await fetchInboundTransfers` per asset (line 514) plus `await blockNumberOf(t.transaction_id)` per transfer found (line 526) — every call serial, no p-limit, no Promise.all, no wall-clock budget, and only a `running` re-entrancy guard on the 5 s timer at lines 565-574. The header comment at 485-488 admits the shape. DOWNGRADED from high because the stated consequence does not follow at the stated load. The watch set size is (payment creation rate x PAYMENT_EXPIRY_MINUTES=30, config/env.ts:73), not cumulative — refreshDepositAddresses (lines 134-151) selects only waiting/confirming/partial, and I confirmed those statuses do drain. 100,000 coins/day at any realistic ticket size is on the order of 1-100 payments/minute, i.e. tens to a few thousand concurrently open on ALL chains combined. With native TRX off by default (assets.ts:350 gates it behind ACCEPT_NATIVE_COINS, config/env.ts:190 default false) and a single TRC20 asset enabled, 1,000 open Tron payments is 1,000 requests per pass — 50-70 s at TronGrid's keyed 15 QPS, i.e. detection latency of about a minute, not the 30 minutes needed to outrun expiry. Reaching that threshold needs roughly 7,000-27,000 simultaneously open TRC20 payments. Also, TronGrid rate limiting does not compound the stall the way claimed: a 429 throws and is caught per (address, asset) at lines 503-508 and 515-522, which returns fast and `continue`s, and the next pass re-queries from the same created_at-derived floor (lines 146-148), so detection is delayed rather than lost. Real, unbounded, worth fixing — but a latency-degradation problem, not a fund-stranding one at this volume.

**Fix.** In backend/src/blockchain/tronListener.ts pollOnce(): (1) replace the serial for-loop at 493-531 with a bounded worker pool — collect the (address, asset) work items into an array and drain it with N in-flight promises, N sized from whether config.tron.apiKey is set (say 5 without a key, 20 with one). (2) Drop the per-transfer `blockNumberOf` round-trip at line 526: TrongridTrc20Tx already carries `block_timestamp`, so resolve the pass's head block once (already done at line 475) and derive the block from the timestamp, falling back to getTransactionInfo only when the transfer is close to the head. (3) Give the pass a wall-clock budget (say 4 s) and round-robin the address set across passes with a module-level cursor index, so a large watch set degrades detection latency linearly instead of producing multi-minute passes. (4) Export `depositAddresses.size` and the pass duration as metrics so the ceiling is visible before it is hit.

### Bitcoin payouts can only spend confirmed UTXOs, so each payout locks the central wallet for ~10 minutes
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/bitcoin.ts:248` — blockchain — status: CONFIRMED

**Evidence.** Confirmed. bitcoin.ts:243-262 `listUtxos` filters `raw.filter((u) => u.status?.confirmed)` at line 248 — deliberate and correct for sweeps (the reasoning at 217-224 about not spending an unconfirmed parent is sound). bitcoinAdapter.ts:285-288 uses the SAME function against the central wallet and throws 'central Bitcoin wallet has no confirmed UTXOs to spend' when it returns empty, and line 322 (`outputs.push({ address: centralAddress, value: change })`) returns change to that same address as a brand-new unconfirmed output. The lock does not cover the gap: chainBroadcast.ts:100-146 wraps only preparePayout + persistPrepared + broadcastPayout in `withChainLock(network,'central', ...)` and releases on return, long before the transaction confirms; the confirmation wait is a separate, later step. So payout B, seconds after payout A, calls listUtxos(centralAddress) against an Esplora UTXO set from which A's input has been removed (Esplora indexes mempool spends) and in which A's change is unconfirmed and filtered out — zero confirmed UTXOs, throw, and BullMQ's 5 attempts at 15 s exponential backoff (queues.ts:52-58) all expire well inside the ~10-minute block interval. Medium is right: no funds are lost, but BTC payout throughput is capped at (confirmed UTXO count) per block and the error message contradicts the visible balance.

**Fix.** In backend/src/blockchain/bitcoin.ts add `listSpendableUtxos(address, ownTxids: Set<string>)` alongside listUtxos: keep confirmed outputs, and additionally admit unconfirmed outputs whose funding txid is one of ours (spending your own change is standard and safe; the risk listUtxos guards against is a third party's unconfirmed deposit). Source ownTxids from `SELECT tx_hash FROM blockchain_transactions WHERE network='BTC' AND direction IN ('payout','sweep') AND status IN ('pending','confirmed')`. Have bitcoinAdapter.preparePayout (line 285) use it and leave bitcoinAdapter.sweepDeposit on the confirmed-only list. Keep the deterministic sort so re-selection over an unchanged set still reproduces the same signed bytes. Add a low-fee-window consolidation job that merges accumulated central-wallet UTXOs, and surface the confirmed-UTXO count next to the balance in the admin panel so the real constraint is visible before a payout fails.

### Native coin detection fetches whole blocks strictly sequentially on a non-batching provider and can fall permanently behind
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmListener.ts:413` — blockchain — status: CONFIRMED

**Evidence.** Confirmed. evmListener.ts:407-431 is `for (let n = fromBlock; n <= toBlock; n++) { const block = await nativeRpc.getBlock(n, true); ... }` — one full block WITH prefetched transaction bodies, awaited one at a time, and `nativeRpc` is constructed by nativeScanProviderFor with `batchMaxCount: 1` (usdt.ts:71-76) so the calls cannot even be pipelined. The budget is a fixed `nativeScanRange: 40` for BSC (evmChains.ts:111) and 10 for Ethereum (evmChains.ts:147) on the 5 s RECONCILE_INTERVAL_MS timer, and reconcileNativeOnce re-reads the cursor each pass (line 536-539) with no sprint mode — so once behind, the gap closes at a fixed 40 blocks/pass regardless of how far behind it is. Throughput is 40/P blocks per second for pass duration P, and break-even against BSC's block rate needs each getBlock(n,true) to average well under a second, which a public dataseed serving full block bodies under load does not reliably do. Medium is correct: ACCEPT_NATIVE_COINS defaults false (config/env.ts:190) and evmListener.ts:807-823 only starts the native timer when nativeAssetFor returns an asset, so a default deployment makes zero of these calls. Note the code comment at line 116-119 assumes ~0.45 s BSC blocks; the real figure is larger, which gives more headroom than the report assumed but does not remove the ceiling.

**Fix.** In backend/src/blockchain/evmListener.ts scanNativeTransfers, replace the strictly serial loop with bounded parallelism — build the block numbers into an array and process it in chunks of 5-8 via Promise.all, preserving recordIncoming ordering per block. `batchMaxCount: 1` still sends each as a separate HTTP request, which is what the public node objected to in usdt.ts:53-70; it was BATCHING that was rejected, not concurrency, so this does not reintroduce the -32005. Make the budget adaptive: in reconcileNativeOnce compute `behind = safeHead - lastScanned` and use `Math.min(behind, cfg.nativeScanRange * (behind > 500 ? 5 : 1))`, narrowing back on any caught error at line 554-560. Export `safeHead - scanTo` (already logged at line 570) as a metric alongside the token lag so a widening native gap is alertable.

### Bitcoin has two required confirmations and no revert path whatsoever
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/bitcoinListener.ts:244` — blockchain — status: CONFIRMED

**Evidence.** Confirmed. bitcoinListener.ts:244 `if (!tx.status?.confirmed || !tx.status.block_height) continue;` records only confirmed transactions, and the header at 14-23 states the absence of a reorg path is a considered choice resting on BTC_REQUIRED_CONFIRMATIONS (default 2, config/env.ts:144). I grepped the whole backend for `reorged`: every write is in evmListener.ts (lines 227, 703) — bitcoinListener.ts and tronListener.ts only READ it inside their RECEIVED_SUM exclusions (bitcoinListener.ts:48, tronListener.ts:51). So no BTC row is ever marked reorged and nothing re-verifies that a recorded transaction is still canonical. The timing is tight: promotion needs `(tip - block_number + 1) >= 2` (bitcoinListener.ts:189), i.e. one block after inclusion, and the sweep then spends the deposit UTXO, credits amount_received, marks the invoice paid, and (with AUTO_PAYOUT_ENABLED) pays the merchant out of the central wallet. A 2-block reorg that replaces the deposit with a conflicting RBF spend leaves all of that standing while the sweep's input no longer exists. The RECEIVED_SUM at lines 43-49 already excludes 'reorged', so the ledger side is ready and only the detector is missing — that part of the report is accurate. Medium is right: per-event loss is the full ticket, but it needs a targeted double-spend and BTC_ENABLED defaults false (config/env.ts:134).

**Fix.** Add the detector rather than only raising the threshold. In backend/src/blockchain/bitcoinListener.ts pollOnce(), before updateConfirmationsAndPromote(tip), select BTC incoming rows with `status IN ('pending','confirmed') AND block_number > $tip - 6`, re-fetch each via getTx(txid) (bitcoin.ts:269-275), and when the result is null or `status.block_height` differs from the recorded block_number, mark the row `status='reorged'` and recompute the payment exactly as evmListener.ts:702-723 does — including the extended `status IN ('confirmed','confirming','swept')` from the reorg-detector fix. Separately make the threshold amount-dependent instead of a flat 2: in the payment-creation path, set required_confirmations to 6 when the BTC amount exceeds a configurable value (add BTC_HIGH_VALUE_THRESHOLD / BTC_HIGH_VALUE_CONFIRMATIONS to config/env.ts), since required_confirmations is already a per-payment column.

### EVM payout addresses are validated by regex only — no EIP-55 checksum, unlike Tron and Bitcoin
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmAdapter.ts:269` — blockchain — status: CONFIRMED

**Evidence.** Confirmed, and it is worse at the write path than at the payout path. evmAdapter.ts:268-270 `isValidAddress` is `/^0x[0-9a-fA-F]{40}$/.test(address)` — shape only. I grepped the entire backend for `getAddress`: zero occurrences, so ethers' EIP-55 check is never used anywhere in this codebase. The asymmetry is exactly as reported: tronAdapter.ts:206 routes to isTronAddress (TronWeb base58check) and bitcoinAdapter.ts:138 routes to isBtcAddress, which round-trips through `bitcoin.address.toOutputScript(address, btcNetwork())` (bitcoin.ts:147-158) and catches both a bad checksum AND a mainnet/testnet mismatch. The merchant-facing write path is regex-only for BOTH EVM chains: routes/account.ts:59 `const WALLET_RE = /^0x[0-9a-fA-F]{40}$/` used for payoutWallet (line 322) and payoutWalletErc20 (line 330); the value goes straight into the UPDATE at lines 353-357 with no normalisation. payoutService.ts:131-134 then calls adapter.isValidAddress, which is the same regex. The secondary claim also holds: assets.ts:513-520 has a `a.network === 'BEP20'` 0x-regex branch and a `a.network === 'TRC20'` base58 branch and no ERC20 branch at all, so a malformed Ethereum contract address passes boot validation.

**Fix.** In backend/src/blockchain/evmAdapter.ts:268-270, import `getAddress` from ethers and implement: accept when the input is all-lowercase or all-uppercase after the 0x (no checksum information is present, so rejecting would break legitimate input), otherwise require `getAddress(address) === address` inside a try/catch. Normalise to the checksummed form before returning it to the caller. Apply the same check at the merchant-facing write in backend/src/routes/account.ts — replace the plain `.regex(WALLET_RE, ...)` on payoutWallet (line 322) and payoutWalletErc20 (line 330) with `.refine()` calls that run the same logic, and store `getAddress(value)` — so the merchant sees the error while they are looking at the field rather than after a payout has gone to an unowned address. Separately add an `if (a.network === 'ERC20' && !/^0x[0-9a-fA-F]{40}$/.test(a.contract)) throw ...` branch to validateAssetList in backend/src/blockchain/assets.ts alongside the existing BEP20 branch at line 515.

### Multiple internal TRX transfers in one transaction collapse to one row and the rest are silently dropped
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/tronListener.ts:398` — blockchain — status: CONFIRMED

**Evidence.** Confirmed. tronListener.ts:239-255 loops `for (const it of tx.internal_transactions ?? [])` and pushes one NativeTransfer per leg, all carrying `txId: tx.txID`; lines 222-236 can additionally push a top-level TransferContract from the SAME transaction with the same txID. Every one of them goes through recordIncomingNative (lines 387-400), which hardcodes `logIndex: -1` at line 398. recordTransfer then inserts with `ON CONFLICT (tx_hash, log_index) DO UPDATE SET block_number = EXCLUDED.block_number` (tronListener.ts:335-336) against `UNIQUE (tx_hash, log_index)` (sql/schema.sql:564) — the amount is NOT in the DO UPDATE list, so the second and subsequent legs update only block_number and their value is lost. RECEIVED_SUM (lines 46-52) then sums one leg. The sentinel comment at 291-297 correctly explains -1 as separating native from token rows in one transaction but does not consider several native legs. The report's framing is right; two gating facts justify medium rather than high: native TRX is only enabled when ACCEPT_NATIVE_COINS=true (assets.ts:350, config/env.ts:190 default false), and it needs a contract-based or batching sender producing multiple TRX legs to one address in one transaction.

**Fix.** In backend/src/blockchain/tronListener.ts fetchInboundNative, add a `legIndex` to the NativeTransfer interface (lines 125-132): 0 for the top-level TransferContract push at 228-234, and `1 + i` for each internal transfer, using the loop index at line 239. Then in recordIncomingNative (line 398) pass `logIndex: -1 - transfer.legIndex` so the top level keeps its existing -1 (no migration needed for existing rows) and internal legs get -2, -3, ... — all still negative and therefore still unambiguously native under UNIQUE (tx_hash, log_index). Alternatively aggregate before recording: sum every inbound leg of one transaction to one address into a single NativeTransfer before returning from fetchInboundNative, which keeps exactly one row per transaction; pick this only if you do not need per-leg provenance. Either way, add a `WHERE blockchain_transactions.amount = EXCLUDED.amount` guard or a RETURNING-based check on the ON CONFLICT at line 335 and log loudly when a conflicting row's amount differs from the incoming one, so a future collapse is visible instead of silent.

### payment.created never fires for any hosted-checkout or invoice payment: enqueueWebhook reads on a pooled connection while the caller's transaction is still open
`backend/src/services/paymentService.ts:295` — business-logic — status: DOWNGRADED

**Evidence.** The mechanism is real and I confirmed every link in it. paymentService.ts:291 is `const row = input.tx ? await body(input.tx) : await withTransaction(body);` and :295 unconditionally calls `enqueueWebhook({ paymentId: row.id, event: 'payment.created' })`. enqueueWebhook's first statement is `queryOne` imported from db/pool (webhookService.ts:82-104), i.e. `pool.query` on a different connection (db/pool.ts:32) — under READ COMMITTED its snapshot is taken at statement start and cannot see the uncommitted row. routes/paymentLinks.ts:170-210 wraps the call in `withTransaction` and passes `tx` at :208, and withTransaction (db/pool.ts:57-58) only issues COMMIT after the callback resolves — while createPayment still has `await QRCode.toDataURL(...)` at :302 ahead of it. So the SELECT is dispatched several milliseconds before COMMIT and reliably returns nothing; webhookService.ts:106-109 logs `enqueueWebhook: payment not found` at warn level and returns null, and the `.catch` at paymentService.ts:295-297 never fires because nothing throws. No webhook_logs row, no delivery. Every invoice goes through this path too — invoiceService.ts:396-416 mints a payment_links row and the customer pays via the same POST /pay/:token/payments. I downgraded from high because no money is lost or misattributed and the merchant is not cut off: payment.confirming (evmListener.ts:273-277) and payment.confirmed (:643) both fire normally from the listener, on the pool, long after COMMIT. What is lost is the creation event and its webhook_logs record, contradicting the contract stated at paymentService.ts:293-294. Under a saturated pool (max 20, db/pool.ts:16) the SELECT can occasionally queue past COMMIT and succeed, which makes the behaviour intermittent rather than merely absent — worse for debugging, not for funds.

**Fix.** Move the enqueue out of createPayment when the caller owns the transaction. Change createPayment's signature to return `{ dto, paymentId }` or accept an `afterCommit?: (paymentId: string) => void` and, when `input.tx` is set, do NOT call enqueueWebhook at :295 — just skip it. Then call `await enqueueWebhook({ paymentId: payment.paymentId, event: 'payment.created' })` in routes/paymentLinks.ts immediately after the `withTransaction(...)` at :210 resolves and before `res.status(201).json(...)` at :215. Do not simply pass the PoolClient into enqueueWebhook: `webhookQueue.add` at webhookService.ts:161 must also happen after COMMIT, or the worker can pick the job up before the payment row is visible and dispatch will hit the same `row missing` path. Add a regression test asserting a webhook_logs row with event='payment.created' exists after POST /pay/:token/payments.

### Idempotency-Key is stored only AFTER the side effect and never fingerprints the body — same key with a different body returns the wrong payment, and concurrent replays both execute
`backend/src/middleware/idempotency.ts:53` — business-logic — status: DOWNGRADED

**Evidence.** Both mechanisms confirmed by reading middleware/idempotency.ts in full. The key IS correctly per-client (`idem:${clientId}:${key}`, :33-34) and the write IS NX (:57), but the write happens inside the res.json wrapper (:51-61), i.e. only after the handler has already committed — so there is no in-flight marker, and the GET at :37 is the only gate. Nothing hashes the body: the replay at :38-43 returns `parsed.body` verbatim whatever the second request asked for, with only an advisory `Idempotent-Replay: true` header. Case (a) — same key, different body returning the wrong paymentId/address — is real and deterministic. Case (b) is materially weaker than claimed, and this is why I downgraded. If the merchant uses the key correctly (same key ⇒ same body), the two concurrent requests carry the SAME orderId, and paymentService.ts:230-236's pre-check is a plain unlocked SELECT so both pass it — but sql/schema.sql:348's `UNIQUE (client_id, order_id)` then rejects the loser's INSERT with 23505, which apiError.ts:92-95 maps to a clean 409 'Resource already exists'. So no duplicate payment and no duplicate deposit address; the harm is that a retry gets a 409 instead of the cached 201, plus a burned HD derivation index. Two payments for one intent require different orderIds under one key, i.e. case (a) again — merchant misuse that a correct implementation is supposed to catch with a 422. The Redis-growth point checks out: paymentService.ts:302-304 puts the QR data URI in the response and idempotency.ts:55 caches the whole body for 24h in the same Redis that backs BullMQ (db/redis.ts).

**Fix.** Reserve before calling next(). Replace the GET at :37 with `SET idem:<client>:<key> {"state":"in_flight","bodyHash":H} NX EX 86400` where H = sha256(method + '\n' + originalUrl + '\n' + req.rawBody) — rawBody is already captured by the express.json verify hook at index.ts:49-53. On SET success, proceed and have the res.json wrapper overwrite the record with `{state:'complete', status, body, bodyHash}` (plain SET, not NX, since we own the key). On SET failure, GET the record: state 'in_flight' → 409 with Retry-After: 1; state 'complete' and bodyHash differs → 422 `idempotency_key_reuse`; otherwise replay. On any non-2xx outcome, DEL the reservation in a `res.on('finish')` handler so a genuine retry can proceed. Strip `qrCode` from the cached body and regenerate it on replay — getPayment already does exactly that at paymentService.ts:323-335, so the code exists. Independently, tighten paymentService.ts:230-233 to `SELECT id FROM payments WHERE client_id=$1 AND order_id=$2 FOR UPDATE` inside the existing transaction so the 409 comes from the friendly path rather than the constraint.

### POST /payouts has no idempotency and the HMAC window allows a 5-minute replay — a retried or replayed request creates a SECOND payout row and a second on-chain transfer
`backend/src/routes/payouts.ts:86` — business-logic — status: DOWNGRADED

**Evidence.** The mechanism is exactly as described. routes/payouts.ts:86-91 mounts only `clientAuth, requireApprovedClient, requireScope(SCOPES.payoutsWrite)` — no `idempotency` middleware, in contrast to routes/payments.ts:50 which does mount it. PayoutSchema (:27-34) is {amount, network?, asset?} with no client reference. requestPayout INSERTs unconditionally at payoutService.ts:189-208. verifyHmac (middleware/auth.ts:189-228) checks only `Math.abs(nowSec - ts) > MAX_SKEW_SECONDS` (:204, MAX_SKEW_SECONDS = 300 at :63) — there is no nonce store and no seen-signature cache anywhere, so identical signed bytes are re-presentable for five minutes. Migration 005 is per-ROW broadcast pinning (nonce/signed_tx/broadcast_at) and says so; it cannot see a second row. I downgraded from high because the money outcome is narrower than stated. The advisory lock at payoutService.ts:169 serialises the two requests, and the balance guard at :176-187 reads the balance INSIDE the lock via getBalanceWith, which subtracts `SUM(gross_amount) WHERE status IN ('pending','processing','sent','confirmed')` (:481-484). So the first payout is already outstanding when the second reads — the second only passes if the merchant genuinely holds 2x, and when it does, the ledger correctly debits both. The result is that the merchant withdraws 10,000 of their OWN available balance instead of 5,000, to their OWN configured wallet (routes/payouts.ts has no destination parameter; requestPayout resolves it from clients.payout_wallet* at :112-119). Real costs: commission charged twice (commissionService.computeSplit runs per row), two network fees, an unintended drain of the gateway balance, and a replayable signed request. Not fund loss, not misattribution.

**Fix.** Put the idempotency in the database where the advisory lock already is. Migration: `ALTER TABLE payouts ADD COLUMN idempotency_key TEXT; CREATE UNIQUE INDEX uq_payouts_client_idem ON payouts(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`. Add `idempotencyKey` to PayoutSchema, require the Idempotency-Key header on POST /payouts, and pass it through requestPayout into the INSERT at payoutService.ts:189-208 — inside the same transaction that already holds the lock at :169 — catching 23505 and returning the existing row with 200 instead of 202. Separately close the HMAC replay window in middleware/auth.ts:225: after safeEqual succeeds, `SET hmac:<apiKeyId>:<sha256(timestamp|signature)> 1 NX EX 300` and reject with 401 if the SET fails. That is a five-line change that also protects POST /payments and every other signed route. Include the Idempotency-Key header value in the signed string (`${timestamp}.${idemKey}.${rawBody}`) so a proxy cannot strip or alter it — this is a versioned change to the signing scheme and must be documented.

### An expired or reverted payment holds its (client_id, order_id) slot forever, so a merchant can never re-offer their own order for payment
`backend/src/services/paymentService.ts:231` — business-logic — status: DOWNGRADED

**Evidence.** Facts all check out. paymentService.ts:230-236 is status-blind: `SELECT id FROM payments WHERE client_id = $1 AND order_id = $2` then `throw AppError.conflict('orderId "..." already exists')`. sql/schema.sql:348 backs it with an unconditional `UNIQUE (client_id, order_id)` — not partial, no status predicate. routes/payments.ts exposes only POST / (:44), GET / (:66) and GET /:id (:84) — there is no extend, reopen, renew or delete, and listPayments (paymentService.ts:346-377) filters only on status, so a merchant cannot even look the orphan up by orderId to recover the address. So after a 30-minute expiry (config/env.ts:73) the merchant's own order key is dead forever. I downgraded from high because nothing here loses, misattributes or double-spends money, and it does not bring the system down: the merchant can always create the payment under a synthetic orderId, and the gateway's ledger stays correct. The real cost is broken merchant-side reconciliation (the synthetic orderId is what every subsequent webhook then carries — webhookService.ts:59 puts row.order_id in the signed payload) plus a lost sale for any integration that surfaces the 409 to the customer. That is degraded correctness, i.e. medium.

**Fix.** Two changes that together make POST /payments naturally idempotent on orderId. Migration: `ALTER TABLE payments DROP CONSTRAINT payments_client_id_order_id_key; CREATE UNIQUE INDEX uq_payments_live_order ON payments (client_id, order_id) WHERE status NOT IN ('expired','failed');` — build it CONCURRENTLY on a live DB and verify no existing duplicates first with `SELECT client_id, order_id, count(*) FROM payments WHERE status NOT IN ('expired','failed') GROUP BY 1,2 HAVING count(*)>1`. Then rewrite paymentService.ts:230-236: `SELECT * FROM payments WHERE client_id=$1 AND order_id=$2 AND status NOT IN ('expired','failed') FOR UPDATE` — on a hit whose status is 'waiting' or 'confirming', return `toDTO(row, qr)` with 200 instead of throwing, so a retry after a proxy timeout gets the address it never received; on a hit that is confirmed/swept, keep the 409 (re-offering a paid order is a merchant bug worth surfacing). Note the FOR UPDATE also fixes the unlocked check-then-insert that currently lets the constraint, rather than the friendly error, catch concurrent duplicates.

### The webhook payload carries no event id, no timestamp and no expected amount, so at-least-once delivery is undedupable, unorderable and replayable forever
`backend/src/services/webhookService.ts:22` — business-logic — status: CONFIRMED

**Evidence.** WebhookPayload is exactly `{event, paymentId, orderId, amount, txHash, status, signature}` (webhookService.ts:22-30) and canonicalBody (:55-65) fixes that as the signed byte layout — no id, no sequence, no timestamp, no expected amount. The only headers sent are x-gateway-signature and x-gateway-event (:203-207), so nothing outside the body helps either. At-least-once is structural: BullMQ retries (queues.ts:28) and the same logical event can be enqueued twice. I confirmed the concrete duplicate path — ethers v6 does not await the listener callback (node_modules/ethers/lib.commonjs/contract/contract.js:486 is a bare `listener.call(contract, ...passArgs)` inside a filter, with only the emit chain serialised by `lastEmit`), so two Transfer logs to one address in the same block run recordIncoming concurrently and both can read `payment.status === 'waiting'` at evmListener.ts:181-196 before either UPDATE at :256-264 lands, firing payment.confirming twice at :273-277. Ordering is likewise unguaranteed: all clients share one queue at concurrency 10 (workers/index.ts:297-301) with per-job backoff. The reorg path produces byte-identical duplicates with no attacker at all: detectReorgs reverts to 'waiting' and clears tx_hash (evmListener.ts:713-723), and when the tx re-confirms the second payment.confirmed carries the same event/paymentId/orderId/amount/txHash/status — hence the same signature. Medium is right: it makes every merchant integration silently non-idempotent, but only under conditions that also require the merchant's handler to be naive.

**Fix.** Add `id` (the webhook_logs row UUID — enqueueWebhook already has it at :159, so move the INSERT above the signing step and sign the id in), `createdAt` (RFC3339), `attempt`, and `amountExpected` to both WebhookPayload (:22-30) and canonicalBody (:55-65), in that fixed key order. Because canonicalBody is the single source of the wire bytes this is contained, but it changes every signature — add `webhook_payload_version INT NOT NULL DEFAULT 1` to clients, keep v1 for existing merchants, and default new merchants to v2. Mirror `id` and `createdAt` as x-gateway-delivery-id and x-gateway-timestamp headers at :203-207 so a receiver can reject a stale replay before parsing. Document `id` as the dedupe key and `createdAt` as the staleness bound in docs/sdk/*.md alongside the existing verification recipe. Note `id` must be stable across retries: dispatch's attempt>=2 branch (:237-245) inserts a NEW webhook_logs row, so sign the ORIGINAL row's id, not the per-attempt one.

### One hanging merchant endpoint starves every other merchant's webhooks: a single queue, 10 slots, 8-second timeout, no per-client fairness
`backend/src/workers/index.ts:297` — business-logic — status: CONFIRMED

**Evidence.** Verified. There is exactly one webhook queue (workers/queues.ts:37-40) and one Worker over it with `{ connection, concurrency: 10 }` (workers/index.ts:297-301). The per-request budget is WEBHOOK_TIMEOUT_MS=8000 (config/env.ts:258) enforced by AbortController at webhookService.ts:193-194 and 209. dispatch (:170-255) has no per-client accounting of any kind, and there is no BullMQ rate-limiter, group key, or per-destination throttle anywhere in queues.ts. A hanging (as opposed to refusing) endpoint therefore burns the full 8s per attempt while holding a slot. While such a merchant's backlog is being attempted, all 10 slots can be theirs, capping gateway-wide throughput at ~1.25 deliveries/s. Slots do free during the exponential backoff between attempts (queues.ts:29), so the collapse is bursty rather than permanent — which is why medium, not high, is the right level. The estimate of ~5 events per payment is consistent with the code: payment.created (paymentService.ts:295), payment.confirming (evmListener.ts:274), payment.confirmed (:643), payment.swept (workers/index.ts:128), payout.completed (payoutService.ts:309), plus invoice.paid (invoiceService.ts:709) and payment.expired (workers/index.ts:176).

**Fix.** Shard delivery by client so one merchant cannot occupy more than 1/N of capacity. Simplest without new infrastructure: create N=8 queues `webhook-0..webhook-7` in queues.ts and pick one at enqueue time with `hashClientId % 8` (enqueueWebhook already has row.client_id at :119), each with its own Worker at concurrency 2 in workers/index.ts. Better if you can take the dependency: BullMQ Pro groups keyed on client_id, or a per-client Redis semaphore checked inside dispatch that re-queues with a short delay when the cap is hit. Add a circuit breaker keyed on client_id in Redis — INCR on failure, DEL on success, and when the counter exceeds K, have dispatch throw immediately without a fetch for a cooldown window, so a dead endpoint costs microseconds instead of 8 seconds. Drop WEBHOOK_TIMEOUT_MS to 3000 and make it overridable per client. Do this together with the retry-ceiling fix, since a longer retry horizon without fairness makes the head-of-line problem worse.

### processSweep and processSettle can both request an auto payout for the same payment, double-settling it and leaving another payment permanently un-payoutable
`backend/src/workers/index.ts:238` — business-logic — status: CONFIRMED

**Evidence.** The check-then-act split is real and spans two processes. processSweep commits `UPDATE payments SET status='swept' WHERE id=$1 AND status='confirmed'` at workers/index.ts:119-122, then does an enqueueWebhook round trip (:128-132) and a getActiveCommission/computeSplit before requestPayout's INSERT commits (payoutService.ts:189-208). processSettle independently selects `p.status='swept' AND NOT EXISTS (SELECT 1 FROM payouts po WHERE po.payment_id=p.id AND po.status IN ('pending','processing','sent','confirmed'))` (workers/index.ts:231-242) and calls requestPayout — and that NOT EXISTS is evaluated on the pool, outside the advisory lock taken later at payoutService.ts:169. There is NO unique constraint to catch it: sql/schema.sql:634-670 has payment_id as a plain nullable FK with only non-unique indexes (:663-670). The advisory lock serialises but does not deduplicate, and the balance guard at :182-187 compares against the client's aggregate (network, asset) balance from getBalanceWith (:468-487), which for an active merchant covers many other payments. The permanent-deficit consequence checks out: once total payout gross exceeds total received by one payment's worth, every later settle tick's requestPayout for the orphaned payment throws 'exceeds available balance', which workers/index.ts:254-257 swallows as a warn — every 60 seconds, forever. Separately, and worth fixing in the same patch: processSettle's requestPayout at :246-253 does NOT pass `asset`, so parseAsset(network, undefined) (assets.ts:390-393) defaults it — a swept USDC payment re-driven by the settle tick is requested as a USDT payout, drawing on the wrong balance and sending the wrong token.

**Fix.** Make auto-payout attribution unique in the database and move the check under the lock. Migration: `CREATE UNIQUE INDEX uq_payouts_auto_payment ON payouts(payment_id) WHERE type='auto' AND status <> 'failed' AND payment_id IS NOT NULL;` (check for existing violations first). In requestPayout, after the advisory lock at payoutService.ts:169 and inside the same transaction, add `if (input.paymentId && input.type === 'auto') { const dup = await tx.query("SELECT id FROM payouts WHERE payment_id=$1 AND type='auto' AND status <> 'failed' FOR UPDATE", [input.paymentId]); if (dup.rowCount) return dup.rows[0]; }` and wrap the INSERT at :189 to catch 23505 on that index and return the existing row. Callers already treat a returned row as success. Also fix workers/index.ts:246-253 to select and pass `p.asset` alongside p.network — the SELECT at :228 must add `p.asset` — so the re-drive path settles the asset that actually arrived, exactly as processSweep does at :148.

### PUT /account/settings uses COALESCE for every field, so a merchant can never clear their webhook URL or a payout wallet — the API returns 200 and ignores it
`backend/src/routes/account.ts:353` — business-logic — status: CONFIRMED

**Evidence.** Read the route in full. routes/account.ts:352-360 is `SET webhook_url = COALESCE($2, webhook_url), payout_wallet = COALESCE($3, payout_wallet), payout_wallet_trc20 = COALESCE($4, ...), payout_wallet_erc20 = COALESCE($6, ...), payout_wallet_btc = COALESCE($7, ...)` with `ip_whitelist = COALESCE($5::text[], ip_whitelist)` and an explicit comment at :357-359 saying '$5 IS NULL means "not supplied"; an empty array is a real value ... and must not be confused with it' — the author identified the exact distinction and applied it to one field only, because an empty array is the clear signal for ip_whitelist while there is no such signal for a scalar. The bound parameters at :366-374 are `body.webhookUrl ?? null` etc., so an explicit null is indistinguishable from absent. The zod schema deliberately allows it: `webhookUrl: z.string().url().nullable().optional()` (:321) and the same for all four wallets (:322-336). The response is rendered from the RETURNING clause (:361-364), so it shows the OLD value and the caller gets a 200 with no signal the write was dropped. Downstream consequence confirmed: enqueueWebhook only skips when webhook_url IS NULL (webhookService.ts:110-113), so an uncleaarable dead URL keeps burning 8 attempts x 8s of a shared delivery slot and writing 8 webhook_logs rows per event, forever.

**Fix.** Build the SET list from the keys actually present on the parsed body. Zod's .optional() drops absent keys, so `'webhookUrl' in body` distinguishes absent from explicit null. Replace the fixed UPDATE with a dynamic one: `const sets: string[] = []; const args: unknown[] = [client.clientId]; const put = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); }; if ('webhookUrl' in body) put('webhook_url', body.webhookUrl); if ('payoutWallet' in body) put('payout_wallet', body.payoutWallet); ...` then `UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ...`, short-circuiting to a plain SELECT when sets is empty. Keep the ip_whitelist trim. Add one test per nullable setting asserting that sending null clears the column AND that the 200 response reflects the cleared value — the current shape would pass a naive test because the response echoes RETURNING.

### reconcilePaidInvoices marks an invoice 'paid' on confirmation status alone, with no comparison of received amount to invoice total
`backend/src/services/invoiceService.ts:703` — business-logic — status: CONFIRMED

**Evidence.** reconcilePaidInvoices (invoiceService.ts:693-717) is `UPDATE invoices i SET status='paid', paid_at=COALESCE(p.confirmed_at, now()), payment_id=p.id FROM payments p JOIN payment_links l ON l.id = p.payment_link_id WHERE l.id = i.payment_link_id AND i.status='open' AND p.status IN ('confirmed','swept')`. There is no comparison of p.amount_received to p.amount, nor to i.total, anywhere in the statement. It inherits the defect from the listeners (see 'underpayment-confirms-as-full') and converts it into a merchant-facing accounting statement plus an invoice.paid webhook (:709). The consequences check out: the payload's amount carries the underpaid figure (webhookService.ts:131-133) while the invoice total is fiat and is not in the payload at all; and voidInvoice refuses a paid invoice (:607-611), so the merchant cannot even withdraw the demand afterwards. Called every 60s from processSettle (workers/index.ts:276).

**Fix.** Add the amount gate to the WHERE at :702-704: `AND p.amount_received >= p.amount * (1 - $1)` with the same tolerance constant used by the listeners. Once the listeners write 'partial' this becomes redundant belt-and-braces, since a partial payment never reaches 'confirmed' — but keep it, because the two are edited by different people at different times. Then give the shortfall somewhere to live: add 'underpaid' to the invoice status CHECK (schema.sql:397-426) and a second UPDATE in the same function matching `p.status='partial'` that sets it, or leave the invoice 'open' and surface `amountReceived` vs `total` on the row so the merchant sees an actionable state. Also relax voidInvoice (:607-611) to permit voiding an underpaid invoice, since today reaching 'paid' is a one-way door.

### Voiding an invoice does not consider a payment already in flight against its link — the money lands, is credited, and the invoice stays 'void' forever
`backend/src/services/invoiceService.ts:599` — business-logic — status: CONFIRMED

**Evidence.** voidInvoice (invoiceService.ts:599-628) locks the invoice row `FOR UPDATE` (:601-603), refuses only `row.status === 'paid'` (:607-611), disables the link with `UPDATE payment_links SET status='disabled'` (:616-621) and sets the invoice void (:623-626). It never queries payments. Disabling the link only affects future claims — unusableReason checks `r.status !== 'active'` at paymentLinkService.ts:151, which is consulted by claimLinkUse (:369) and getPublicLink (:319), neither of which touches an already-created payment. The existing payment keeps status 'waiting'/'confirming', so it stays in every listener's watch set (evmListener.ts:147 et al) and runs its full lifecycle to confirmed → swept. It then counts toward the merchant's withdrawable balance: getBalanceWith sums `amount_received FROM payments WHERE client_id=$1 AND status IN ('confirmed','swept')` (payoutService.ts:468-472) with no invoice awareness at all. reconcilePaidInvoices matches only `i.status='open'` (invoiceService.ts:702), so the invoice stays 'void' permanently and nothing logs the combination. Confirmed with the refund finding: there is no path to return the money.

**Fix.** Inside voidInvoice's existing transaction, immediately after the invoice lock at :603, add `const live = await tx.query("SELECT id, status, amount_received FROM payments WHERE payment_link_id = $1 AND status IN ('waiting','confirming','partial')", [row.payment_link_id])`. If any row has amount_received > 0, refuse with a 409 explaining that funds are already in flight and naming the payment id. If rows exist but nothing has arrived, allow the void AND expire those payments in the same transaction (`UPDATE payments SET status='expired' WHERE id = ANY(...) AND amount_received = 0`) so the deposit addresses leave the watch set together with the demand. Independently, add an exception detector to processSettle: select payments in ('confirmed','swept') whose linked invoice status is 'void' and log/alert them — today that combination produces no row, no log and no alert anywhere.

### There is no refund capability anywhere in the system — overpayment, mis-send and cancelled-but-paid all terminate with money on one side and no mechanism to return it
`backend/src/services/invoiceService.ts:609` — business-logic — status: CONFIRMED

**Evidence.** Verified by exhaustive grep. Case-insensitive 'refund' across backend/src returns exactly two hits: the string 'Refund it out of band if needed.' at invoiceService.ts:609, and an unrelated comment about router refunds at evmListener.ts:122. Across sql/ it returns nothing — no refunds table, no status, no enum member. No route, service, queue or webhook event exists. Overpayment is kept in full, as claimed: processSweep calls adapter.sweepDeposit which moves the whole balance (workers/index.ts:88-98) and then requests an auto payout of `balanceHuman`, the swept amount, not the invoiced amount (:140-151) — so 200 sent against a 100 invoice settles 200 to the merchant with nothing recording that 100 was unowed. The only operator tool is unexpected-deposit recovery (routes/account.ts:649-711), and it does exactly what the auditor says: `adapter.sweepDeposit` to the CENTRAL wallet (:680-685, adapter.centralWalletAddress), i.e. to the gateway operator, with no path back to the payer and no entry in the merchant's ledger. And the payer is unrecoverable on Bitcoin: bitcoinListener.ts:117-120 writes the literal `'(utxo inputs)'` as from_address with a comment explaining the choice. EVM/Tron do capture from_address (evmListener.ts:222/231, tronListener.ts:332/337) but no route or view surfaces it.

**Fix.** This needs a product decision plus schema. Minimum viable: (1) a `refunds` table keyed to payment_id with amount, asset, network, to_address, status, and the same nonce/signed_tx/broadcast_at idempotency pins that migration 005 added to payouts — reuse broadcastTransferOnce (services/chainBroadcast.ts) verbatim so a refund can never double-send. (2) Default to_address from `SELECT from_address FROM blockchain_transactions WHERE payment_id=$1 AND direction='incoming' AND status<>'reorged' ORDER BY block_number LIMIT 1`, requiring explicit operator confirmation before broadcast. (3) An accounting entry so a refunded amount LEAVES the merchant's available balance: add `- SUM(amount) FROM refunds WHERE status IN ('pending','sent','confirmed')` to getBalanceWith (payoutService.ts:468-487) and to getAllBalances (:385-415), or the refund is paid out from under the merchant. (4) A refund.* webhook family. (5) Record the real payer on Bitcoin: Esplora returns each input's `prevout.scriptpubkey_address`, so store the first input's address instead of '(utxo inputs)' at bitcoinListener.ts:117-120 — losing it is not honesty, it is discarding recoverable data.

### The expiry worker can mark a payment `expired` between the customer's transaction being mined and the listener recording it, after which the deposit is not credited
`backend/src/workers/index.ts:165` — concurrency — status: DOWNGRADED

**Evidence.** The RACE is real; the 'invisible, awaiting a manual recover.ts run' consequence is not. high -> medium.

Race, confirmed:
- workers/index.ts:166-172: `UPDATE payments SET status='expired' WHERE status='waiting' AND expires_at < now()` — no grace period, no check for in-flight funds.
- evmListener.ts:187-196 matches only `status IN ('waiting','confirming','partial')`; tronListener.ts:305-315 and bitcoinListener.ts:90-100 are identical. An expired payment does not match.
- Detection genuinely lags: evmListener.ts:440 `safeHead = head - cfg.reorgDepth` with REORG_DEPTH=15, plus RECONCILE_INTERVAL_MS = 5_000 (:96).

What refutes the severity: on EVM and Tron the miss falls through to `recordUnexpectedDeposit` (evmListener.ts:203-211, tronListener.ts:319-326), and I read that service. unexpectedDepositService.ts:88-107 resolves the owner through `wallets` with NO payment-status filter, so an EXPIRED payment's late deposit still resolves client_id, payment_id, expected_asset and — critically — `derivation_index`, and is inserted at :110-129 with a `logger.warn` at :142-152. The module header (unexpectedDepositService.ts:20-27) names this exact case 'LATE PAYMENT' and it has a merchant-facing UI. So the funds are recorded, attributed, and recoverable by index; they are not invisible and no hand-run recover.ts is needed to FIND them.

One thing the auditor missed that is worse than what they reported: bitcoinListener.ts:104 is a bare `if (!payment) return;` with no recordUnexpectedDeposit call and the comment 'No wrong-asset case to handle'. On BTC a late payment IS silently dropped — no row, no warn, nothing. That is the part of this finding that genuinely needs fixing first.

The residual real defect: a customer who paid before expiry is told their order expired and is pushed onto a manual recovery path that should not have been needed.

**Fix.** (a) workers/index.ts:166-172 — give the chain a grace period and refuse to expire a payment with funds in flight:
```sql
UPDATE payments p
   SET status = 'expired'
 WHERE p.status = 'waiting'
   AND p.expires_at < now() - (p.required_confirmations * interval '1 second' * $1)
   AND NOT EXISTS (
     SELECT 1 FROM blockchain_transactions bt
      WHERE bt.payment_id = p.id
        AND bt.direction = 'incoming'
        AND bt.status <> 'reorged'
   )
RETURNING id
```
with $1 the network's block time (add `blockTimeSeconds` alongside `reorgDepth` in evmChains.ts, and a constant for Tron/BTC), so the grace is derived per chain rather than hardcoded. `idx_payments_expires` (schema.sql:359) already covers the predicate.

(b) Un-expire rather than orphan. In evmListener.ts:190, tronListener.ts:309 and bitcoinListener.ts:94 widen the match to `status IN ('waiting','confirming','partial','expired')`, and in the UPDATE that follows (evmListener.ts:256-264 and its two siblings) change the CASE to `WHEN status IN ('waiting','expired') THEN 'confirming' ELSE status END`. The money arrived at an address derived for exactly this payment; crediting it is correct and is what the customer was told would happen. Emit `payment.confirming` on the un-expire so the merchant's webhook consumer sees the reversal.

(c) Fix the BTC hole regardless of (a) and (b): bitcoinListener.ts:104 must call `recordUnexpectedDeposit({ network: 'BTC', asset: BTC, amountHuman, depositAddress: address, txHash: txid, logIndex: vout })` instead of returning silently.

### `updateConfirmationsAndPromote` scans `blockchain_transactions` through an unindexed predicate several times per 5-second pass
`backend/src/blockchain/evmListener.ts:583` — concurrency — status: DOWNGRADED

**Evidence.** The INDEX GAP is real and worth fixing; the reasoning about why it is dangerous is mostly wrong, so high -> medium.

What holds:
- evmListener.ts:583-591 is as quoted, with no LIMIT and no block_number bound.
- The table's only indexes are schema.sql:566-570: idx_btx_payment(payment_id), idx_btx_to(to_address), idx_btx_block(block_number), idx_btx_network(network), idx_btx_network_asset(network, asset). There is nothing on `status` or `direction`. Contrast payments, which has idx_payments_status, idx_payments_network_status and a partial idx_payments_expires (schema.sql:356-371) — the gap is specific to this table.
- On a single-chain deployment `network = 'BEP20'` matches 100% of rows, so idx_btx_network buys nothing and the planner will sequential-scan.
- Call frequency is as claimed: reconcileOnce invokes it at :449 AND again at :512 (back to back inside one pass), and reconcileNativeOnce invokes it at :563 on its own 5s timer. Each invocation runs three statements (:583, :594, :607), and the middle one joins payments.

What does not hold, and is the reason for the downgrade:
- 'Rewrites the whole table' is false. The UPDATE writes new tuple versions only for MATCHED (pending) rows. In steady state that is the handful of transfers currently inside their confirmation window, each rewritten a couple of times before promotion — not mass churn, and autovacuum keeps up easily.
- 'Rows stay pending forever / the table grows without bound in the pending set' is largely false. evmListener.ts:631-637 clears every pending incoming row for a payment the moment it is promoted, and recordIncoming (:181-196) will not create a pending row for a payment that is already confirmed/swept/expired — those go to unexpected_deposits instead. I could only construct one narrow leak: a payment reorg-reverted to 'waiting' (:713-723) that then expires while a sibling incoming row is still 'pending'.

So the real cost is a repeated sequential scan of a table that grows by thousands of rows a day, ~6 times per 5 seconds per chain — genuine DB-CPU pressure at multi-million-row scale, competing with the payout advisory-lock balance reads, but not the bloat spiral described.

**Fix.** (a) Index the predicate:
```sql
CREATE INDEX CONCURRENTLY idx_btx_pending_incoming
  ON blockchain_transactions (network, block_number)
  WHERE direction = 'incoming' AND status = 'pending';
```
A partial index, so it stays small precisely because it only covers the working set. Add it to sql/schema.sql after line 570 and as a new migration.

(b) Bound the UPDATE to the range that can still change — append to evmListener.ts:583-591 (and the identical tronListener.ts:408-416, bitcoinListener.ts:159-167):
```sql
  AND block_number > $1 - $2
```
with $2 = `cfg.requiredConfirmations + cfg.reorgDepth`. Already-final rows are then never touched again.

(c) Call it once per pass, not twice: delete the invocation at evmListener.ts:449. The pass at :512 already runs after the scan and covers everything :449 would have.

(d) Close the leak so pending rows have a terminal state: when processExpiry marks a payment expired, transition its incoming rows out of pending in the same statement — `UPDATE blockchain_transactions SET status='orphaned' WHERE payment_id = ANY($1) AND direction='incoming' AND status='pending'`.

### POST /payouts has no idempotency key and no dedupe, so a retried request creates a second payout
`backend/src/routes/payouts.ts:86` — concurrency — status: CONFIRMED

**Evidence.** Confirmed, though the most likely attacker is a retrying HTTP client rather than a signature thief.

- routes/payouts.ts:86-91 mounts exactly `clientAuth, requireApprovedClient, requireScope(SCOPES.payoutsWrite), asyncHandler(...)`. The `idempotency` middleware that POST /payments carries (routes/payments.ts:49) is absent, and it is not imported in the file.
- requestPayout has no dedupe of its own: payoutService.ts:189-208 is an unconditional INSERT. There is no unique constraint that could catch it either (schema.sql:663-670, and no migration adds one).
- The HMAC replay defence is a timestamp window only: middleware/auth.ts:203-206 `if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) throw`, with `MAX_SKEW_SECONDS = 5 * 60` at :63. verifyHmac (:189-228) stores nothing — the same (X-Timestamp, X-Signature, body) triple verifies as many times as presented inside those five minutes.
- The advisory lock at payoutService.ts:169-172 is keyed on `(clientId, network)` and prevents overdraw of the aggregate balance, not duplication of intent. Two identical requests both pass the guard whenever the merchant has that much available — which, right after a large deposit sweeps in, they do.

One correction to the framing: routes/payouts.ts's own header notes payouts:write is reachable by an HMAC key OR a dashboard session, and a dashboard session carries no HMAC at all. So for the most likely duplicate — a double-clicked Payout button or a browser retry on a 502 — the 5-minute skew window is irrelevant; there is simply no dedupe anywhere on the path. That makes the finding easier to trigger than the replay framing suggests, not harder.

**Fix.** (a) Require an idempotency key on this route. routes/payouts.ts:86-91:
```ts
router.post('/', clientAuth, requireApprovedClient, requireScope(SCOPES.payoutsWrite),
  (req, res, next) => req.header('Idempotency-Key')
    ? next()
    : next(AppError.badRequest('POST /payouts requires an Idempotency-Key header.')),
  idempotency,
  asyncHandler(async (req, res) => { ... }));
```
Unlike payment creation there is no natural uniqueness key to fall back on, so it must be mandatory rather than optional. Apply the in-flight reservation fix from the idempotency finding first, or two truly concurrent submissions still both execute.

(b) Close the replay hole in the signature scheme itself, which protects every signed route rather than just this one. In verifyHmac (middleware/auth.ts), after the skew check at :204-206 and after `safeEqual` succeeds at :225:
```ts
const claimed = await redis.set(`sig:${row.api_key_id}:${signature.toLowerCase()}`, '1', 'PX', (MAX_SKEW_SECONDS + 30) * 1000, 'NX');
if (claimed !== 'OK') throw AppError.unauthorized('Signature already used (replay protection)');
```
A 5.5-minute TTL covers the whole skew window at negligible Redis cost. Note this makes verifyHmac async — merchantAuth already awaits its way through :105-137, so change the call at :130 to `await verifyHmac(...)`.

(c) For the browser path, disable the Payout button on submit in the client panel; that is where the double-click actually originates.

### `withChainLock` has a fixed 60s TTL and no renewal, so a slow broadcast lets a second signer take the lock and pick the same nonce
`backend/src/utils/chainLock.ts:47` — concurrency — status: CONFIRMED

**Evidence.** Confirmed, and the outcome is sharper than the auditor spelled out.

- chainLock.ts:104 is a single `redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')` with `LOCK_TTL_MS = 60_000` (:47). There is no watchdog: :119-129 is `try { return await fn(); } finally { redis.eval(RELEASE_SCRIPT, ...) }` and nothing extends the key while fn runs.
- The release IS correctly token-checked (RELEASE_SCRIPT :59-64, invoked :123), so a late holder cannot delete someone else's lock — but nothing stops it from continuing to sign after its own lease lapsed.
- The critical section is unbounded: chainBroadcast.ts:133-145 runs preparePayout (evmAdapter.ts:444-482: getTransactionCount + populateTransaction, which itself makes fee and estimate calls + signing), then persistPrepared (a DB write), then broadcastPayout.
- The waiter is always there: chainLock.ts:103-110 retries every 100ms for up to 45s, and the payout (concurrency 3) and admin-withdraw (concurrency 2) workers across N replicas all contend for the single `chainlock:BEP20:central` key.

The consequence, which I traced further than the report did: when A and B both pin nonce N and A's transaction mines first, B's broadcast is rejected with 'nonce too low' — and evmAdapter.ts:498-508 explicitly treats that as success:
```ts
const alreadyOnChain = message.includes('already known') || ... || message.includes('nonce too low') || ...;
if (alreadyOnChain) { logger.info(...); return { txHash }; }
```
So executePayout sails past the try/catch to payoutService.ts:302-305 and writes `status='sent', tx_hash=<a hash that will never appear on chain>`. getBalanceWith (:481-485) counts 'sent' as paid out and the settle tick's NOT EXISTS (workers/index.ts:241) includes it, so the payout is never re-driven. The merchant is not paid, the balance says they were, and nothing surfaces it. That is a silent stuck-funds outcome, correctly identified.

(If instead A's transaction is still in the mempool, B gets 'replacement transaction underpriced', which is NOT in the alreadyOnChain list, so B throws -> markFailed -> and the row becomes fuel for the settle-tick re-mint finding.)

**Fix.** (a) Add a token-checked renewal watchdog to withChainLock (chainLock.ts:119-129):
```ts
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

let lost = false;
const renewer = setInterval(() => {
  void redis.eval(RENEW_SCRIPT, 1, key, token, String(LOCK_TTL_MS))
    .then((r) => { if (r === 0) lost = true; })
    .catch(() => { lost = true; });
}, Math.floor(LOCK_TTL_MS / 3));

try {
  return await fn(() => {
    if (lost) throw new Error(`lost the ${network} ${role} signing lock mid-operation; aborting before signing`);
  });
} finally {
  clearInterval(renewer);
  try { await redis.eval(RELEASE_SCRIPT, 1, key, token); } catch (err) { logger.warn(...); }
}
```
Pass the `assertHeld` callback through to chainBroadcast and call it immediately before `adapter.preparePayout` (chainBroadcast.ts:133) and again before `adapter.broadcastPayout` (:144), so a lapsed lease aborts rather than signs.

(b) Bound the RPC calls inside fn so a hung provider fails fast rather than running past the lease. Wrap the provider in evmAdapter.ts with a per-call timeout well under LOCK_TTL_MS (e.g. 20s) — `Promise.race([call, timeout])` around getTransactionCount and populateTransaction in preparePayout.

(c) Independently, tighten evmAdapter.ts:498-508. 'nonce too low' does NOT mean 'this transaction landed' — it means SOME transaction at that nonce landed, possibly a different one. Before returning success, verify: `const rc = await provider().getTransactionReceipt(txHash); if (!rc) throw new Error('nonce consumed by a different transaction — ' + txHash + ' is not on chain; manual review required');`. Keep 'already known' / 'known transaction' / 'duplicate' as success, since those genuinely identify the same bytes.

### The hosted-checkout path holds a `payment_links` FOR UPDATE row lock and a pool connection across an outbound CoinGecko request
`backend/src/routes/paymentLinks.ts:170` — concurrency — status: CONFIRMED

**Evidence.** Confirmed; the whole chain is in the code.

- routes/paymentLinks.ts:168-210: `await withTransaction(async (tx) => { const { link, clientId } = await claimLinkUse(tx, token); ... return createPayment({ ..., tx }); })`.
- paymentLinkService.ts:355-361 takes the lock: `SELECT l.*, c.business_name, ... FROM payment_links l JOIN clients c ... WHERE l.token = $1 FOR UPDATE OF l`, held to COMMIT.
- createPayment does the fiat conversion at paymentService.ts:197-202 (`const q = await quote({...})`) BEFORE it ever calls `body(input.tx)` at :291. The comment at :191-194 ('Deliberately BEFORE the transaction') is true for the direct API path where createPayment owns the transaction, and false for the link path where the caller's transaction is already open. That is a genuine, easy-to-miss invariant break, correctly spotted.
- The blocking cost is real: quote -> getRates reads Redis fast, but on a cold cache (rateService.ts:429-436) or beyond RATE_MAX_STALE_SECONDS (:414-427) it calls refreshSingleFlight (:353-381), which either performs the upstream fetch itself or polls `await new Promise(r => setTimeout(r, 250))` for up to 3 seconds and THEN fetches anyway (:368-380). The fetch is bounded only by config.rates.timeoutMs (:248-249).
- Every other customer on the SAME link then queues on that row lock, each holding one of pool.ts:16's 20 connections, with pool.ts:18's 10s acquire timeout waiting behind it.

Worth noting the design does the right thing on the common path: the fresh (:400-403) and stale (:405-412) branches both return without blocking, and the stale branch repairs in the background. So this only bites on a cold cache or a genuine provider outage — which is precisely the scenario rateService's three-tier design exists to survive, and this call site defeats it.

**Fix.** Resolve the quote before the transaction opens. In routes/paymentLinks.ts:168-210:
```ts
// 1. Unlocked read, purely to learn whether this link is fiat-priced.
const pricing = await queryOne<{ fiat_amount: string | null; fiat_currency: string | null; asset: string | null; network: string | null }>(
  `SELECT fiat_amount, fiat_currency, asset, network FROM payment_links WHERE token = $1`, [token]);

// 2. Do the slow thing outside every lock and every connection.
let preQuoted: LockedQuote | undefined;
if (pricing?.fiat_amount && pricing.fiat_currency) {
  const q = await quote({ asset: pricing.asset ?? body.asset ?? 'USDT', fiatCurrency: pricing.fiat_currency, fiatAmount: pricing.fiat_amount });
  preQuoted = { currency: q.fiatCurrency, amount: q.fiatAmount, rate: q.rate, source: q.source, lockedAt: q.lockedAt };
}

// 3. Now take the lock, re-validate under it, and create.
const payment = await withTransaction(async (tx) => {
  const { link, clientId } = await claimLinkUse(tx, token);
  // re-check that the link's pricing did not change between (1) and (3)
  if ((link.fiat_currency ?? null) !== (pricing?.fiat_currency ?? null) || (link.fiat_amount ?? null) !== (pricing?.fiat_amount ?? null)) {
    throw AppError.conflict('This payment link changed while you were opening it. Reload and try again.');
  }
  return createPayment({ ..., preQuoted, tx });
});
```

And add `preQuoted?: LockedQuote` to CreatePaymentInput (paymentService.ts:114-149), with paymentService.ts:197 becoming `if (input.preQuoted) { locked = input.preQuoted; amount = <crypto amount from the quote>; } else if (pricedInFiat) { ... }`. Then tighten the comment at :191-194 to state the actual rule: no external HTTP call may occur between BEGIN and COMMIT on any path, and a caller that supplies `tx` MUST supply `preQuoted` for a fiat-priced payment. Consider asserting it (`if (input.tx && pricedInFiat && !input.preQuoted) throw new Error(...)`) so the next caller cannot reintroduce this.

### Bitcoin payout input selection only considers confirmed UTXOs, so consecutive payouts cannot see their predecessor's change and serialise to roughly one per block
`backend/src/blockchain/bitcoinAdapter.ts:285` — concurrency — status: CONFIRMED

**Evidence.** Confirmed as a throughput/liveness limit. One half of the stated failure mode is wrong and the knock-on to the double-pay finding does not hold — the severity is right for different reasons.

Confirmed:
- bitcoinAdapter.ts:285 `const available = await listUtxos(centralAddress);` and bitcoin.ts:243-262 filters `raw.filter((u) => u.status?.confirmed)` at :248. Change from a just-broadcast payout is unconfirmed and therefore invisible to the next one.
- The chain lock is released the moment the broadcast returns (chainLock.ts:34-38 documents this as deliberate, and it is correct for nonce-based chains) — but on Bitcoin releasing it does not make the spendable set correct, because that set only updates when a block is mined. That is the real insight here and it is right.
- BTC_REQUIRED_CONFIRMATIONS defaults to 2 (config/env.ts:500) at ~10-minute blocks, so the confirmed UTXO set refreshes at most six times an hour. With a consolidated central wallet (one large UTXO), payout B after payout A simply throws `insufficient confirmed Bitcoin balance` (bitcoinAdapter.ts:310-315) or `central Bitcoin wallet has no confirmed UTXOs to spend` (:286-288).

Refuted, and worth correcting so nobody chases it:
- The 'conflicting double-spend' variant (selecting the identical deterministic prefix and broadcasting a conflict) does not happen. Esplora's `/address/{addr}/utxo` excludes outputs already spent in the mempool, so A's inputs are gone from B's view; B starves, it does not double-spend.
- The link to the settle-tick re-mint finding does not hold either. Both failures above are thrown by preparePayout BEFORE anything is signed or broadcast, so markFailed leaves `broadcast_at` and `signed_tx` NULL. A re-minted P2 for such a payment is genuinely safe. This is a stuck-payout problem, not a fund-loss one.

**Fix.** (a) Let the wallet spend its own unconfirmed change, which is safe because a third party cannot double-spend it. Give listUtxos a flag and pass the set of self-signed txids:
```ts
export async function listUtxos(address: string, allowUnconfirmedTxids?: Set<string>): Promise<Utxo[]> {
  return raw
    .filter((u) => u.status?.confirmed || allowUnconfirmedTxids?.has(u.txid))
    .map(...)
    .sort(...);   // keep (height ?? Number.MAX_SAFE_INTEGER, txid, vout) so unconfirmed sorts last and selection stays deterministic
}
```
and at bitcoinAdapter.ts:285 supply them from the ledger:
```sql
SELECT tx_hash FROM payouts WHERE network='BTC' AND status IN ('sent','confirmed') AND tx_hash IS NOT NULL AND created_at > now() - interval '24 hours'
UNION SELECT tx_hash FROM admin_withdrawals WHERE network='BTC' AND status IN ('sent','confirmed') AND tx_hash IS NOT NULL AND created_at > now() - interval '24 hours'
```

(b) Reserve inputs so two payouts prepared inside the same block cannot select the same UTXO. Add:
```sql
CREATE TABLE btc_reserved_utxos (
  txid TEXT NOT NULL, vout INT NOT NULL,
  payout_id UUID REFERENCES payouts(id) ON DELETE CASCADE,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (txid, vout)
);
```
Inside the existing `withChainLock(network, 'central', ...)` (chainBroadcast.ts:100), select from confirmed-plus-self-change MINUS anything in that table, and INSERT the reservations in the SAME transaction that persists signed_tx (payoutService.ts:283-290). Release them when the spending transaction confirms, or when a row is moved to the `needs_review` terminal state.

(c) Make the failure legible rather than a bare throw: when selection starves purely because everything is unconfirmed, throw a distinct message ('all central BTC UTXOs are unconfirmed; retrying after the next block') and give the BTC payout queue a backoff on the order of a block time rather than queues.ts:69-72's 15s exponential, so five attempts are not burned inside four minutes.

### The confirmation tracker runs an unindexed scan of `blockchain_transactions` three times per pass, every 5 seconds, per chain
`backend/src/blockchain/evmListener.ts:583` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** The missing index is real; the bloat mechanism is not, and the second and third statements are not full scans — so this is degradation, not a system that falls over.

WHAT IS TRUE. evmListener.ts:583-591 issues `UPDATE blockchain_transactions SET confirmations = GREATEST(0, $1 - block_number) WHERE direction = 'incoming' AND status = 'pending' AND network = 'BEP20' AND block_number IS NOT NULL` with no supporting index. I read the full index set — schema.sql:566-570 gives only `idx_btx_payment`, `idx_btx_to`, `idx_btx_block`, `idx_btx_network`, `idx_btx_network_asset` — and grepped all 21 migrations: the only additions are `idx_btx_network` (004:44) and `idx_btx_network_asset` (008:59). Nothing covers `(direction, status)`. On a single-chain-dominant table `network = 'BEP20'` matches ~100% of rows, so the planner has no selective path and `block_number IS NOT NULL` is not selective either. Called from :449, :512 and (via the native timer) :563 — three scans per 5s per chain, plus the same shape at tronListener.ts:408 and bitcoinListener.ts:159.

WHAT IS NOT TRUE, and why the severity drops:
- 'rewrites a row version for every matching row … the table bloats continuously.' The predicate matches only `status = 'pending'` rows, and every promotion flips them to `confirmed` (evmListener.ts:631-637). That is a small live subset — hundreds, not millions. The write volume is bounded by in-flight deposits, not by table size. Autovacuum is not driven behind by this.
- 'The same pass then runs the payments join, which has the same shape.' It does not. The second UPDATE (:594-604) and the `ready` SELECT (:607-617) both carry `p.status = 'confirming'`, which `idx_payments_status` (schema.sql:357) and `idx_payments_network_status` (:362) serve directly, so the planner drives from the small payments side.
- 'saturates Postgres CPU and I/O … turns directly into API pool.connect() timeouts.' Only two listeners are actually deployed (docker-compose.yml:53, :66), so it is 6 scans per 5s, not 12, and the effect is a rising floor on DB load rather than a cliff.

What remains is a scan cost that grows without bound as the table does, which is a genuine medium: degraded availability under load.

**Fix.** (1) New migration `sql/migrations/022_btx_pending_index.sql`:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_btx_pending_incoming
  ON blockchain_transactions (network, block_number)
  WHERE direction = 'incoming' AND status = 'pending';
```
Partial, so it stays tiny — it indexes only the live set — and it makes all three listeners' first statement an index scan over exactly the right rows. Run it with CONCURRENTLY outside a transaction block; note that the existing migration runner must not wrap it in BEGIN.
(2) Add the no-op guard so an unmoved head writes nothing. It buys little on BSC (~11 new blocks per 5s pass) but a great deal on Bitcoin, whose 30s poll sees the same tip for ~20 consecutive passes. Append `AND confirmations <> GREATEST(0, $1 - block_number)` to evmListener.ts:583-591, tronListener.ts:408-416, and `AND confirmations <> GREATEST(0, $1 - block_number + 1)` to bitcoinListener.ts:159-167.
(3) Bound the work at the far end: add `AND block_number > $2` driven by `head - (cfg.reorgDepth + p.required_confirmations + margin)` so rows long past finality are never revisited. This is the change that stops the cost growing with table size rather than just making the constant smaller.

### The settle safety net re-enqueues the oldest 500 `confirmed` payments every minute, and BullMQ's jobId dedupe makes most of those re-enqueues silent no-ops
`backend/src/workers/index.ts:203` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Confirmed as written, and the safety net is even weaker than described.

The query is exactly as quoted — workers/index.ts:203-209, `SELECT id FROM payments WHERE status = 'confirmed' ORDER BY confirmed_at ASC NULLS FIRST LIMIT $1` with `SETTLE_BATCH_LIMIT = 500` (:194) — and the bound and ordering are deliberate per the comment at :199-202. The assumption that rows leave `confirmed` is what fails.

I verified three sources of permanently-stuck rows, not two:
1. Orphaned sweep — see the worker-shutdown finding. `sweepDeposit` returns null at evmAdapter.ts:343 because the balance is now 0, and processSweep returns at workers/index.ts:94-97 without touching the status.
2. The Ethereum gas-ceiling deferral, evmAdapter.ts:352-357, which returns null by design and leaves the payment `confirmed` for as long as fees stay high. Note this is ERC20-only: BSC uses `gasPolicy: { mode: 'fixed', … }` (evmChains.ts:109) and never takes that branch.
3. THE ONE THE WRITE-UP MISSED, and the most routine: an empty gas station. evmAdapter.ts:359-366 throws `'sweep requires gas funding but no gas station key configured'`, and a funded-but-empty gas wallet fails the same way inside `fundTx`. The job exhausts its 5 attempts (queues.ts:44-48) and the payment stays `confirmed` forever.

And the recovery path is blocked by BullMQ itself. `sweepQueue.add(..., { jobId: `sweep-${p.id}` })` (workers/index.ts:211-213) dedupes on the job KEY regardless of state: scripts/addStandardJob-9.js:520-524, `jobIdKey = args[1] .. jobId; if rcall("EXISTS", jobIdKey) == 1 then return handleDuplicatedJob(...)`. With `removeOnComplete: 1000` / `removeOnFail: 5000` (queues.ts:30-31) that key survives thousands of subsequent jobs, so once a payment's sweep job has finished or failed, every settle-tick re-enqueue for it is a no-op. The tick logs `capped: true` (:263) with nothing distinguishing 'catching up' from 'permanently jammed'.

**Fix.** (1) Stop the head-of-line block. New migration: `ALTER TABLE payments ADD COLUMN sweep_attempts INT NOT NULL DEFAULT 0, ADD COLUMN last_sweep_attempt_at TIMESTAMPTZ;` plus `CREATE INDEX idx_payments_sweep_retry ON payments (last_sweep_attempt_at NULLS FIRST) WHERE status = 'confirmed';`. Change workers/index.ts:203-209 to `ORDER BY last_sweep_attempt_at ASC NULLS FIRST` and stamp `UPDATE payments SET sweep_attempts = sweep_attempts + 1, last_sweep_attempt_at = now() WHERE id = ANY($1)` right after the enqueue loop. A row that keeps failing moves to the BACK of the queue instead of squatting at the front.
(2) Make the re-enqueue actually re-enqueue. Add `removeOnComplete: true, removeOnFail: 50` to the settle-tick `sweepQueue.add` options at :211-213 so the jobId key does not outlive the job.
(3) Give up loudly. After `sweep_attempts > 20`, `UPDATE payments SET status = 'needs_attention'` with the last error recorded, so the row leaves the batch and surfaces in the admin panel instead of being retried silently forever.
(4) Fix the root causes: the `swept`-when-a-prior-sweep-tx-exists branch from the worker-shutdown finding, and a distinct status (or at minimum a `deferred_reason` column) for the evmAdapter.ts:352-357 gas-ceiling deferral so it is not indistinguishable from an unswept payment.

### The EVM reconciler puts every watched deposit address into a single `eth_getLogs` topic array with no cap, and a failure freezes the token cursor permanently
`backend/src/blockchain/evmListener.ts:471` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** The code path is exactly as described and the freeze is demonstrable from the source; only the trigger threshold is provider-dependent.

evmListener.ts:471 `const watched = Array.from(depositAddresses);` — unbounded, refreshed every 30s from every `waiting`/`confirming`/`partial` payment (:143-149, :787 `ADDRESS_REFRESH_MS = 30_000`). :475 `const filter = token.filters.Transfer(null, watched);` puts the whole array into the indexed `to` topic, one 66-char padded value per address, and :478 issues it.

The freeze is unambiguous. :479-485:
```
} catch (err) {
  logger.error({ err, fromBlock, scanTo, asset: asset.symbol }, 'queryFilter failed; will retry next pass');
  return; // do NOT advance the cursor — retry the whole range next pass
}
```
That `return` exits reconcileOnce entirely, so it also skips every remaining asset in the same pass, and `chain_cursor.last_scanned_block` (updated only at :513-516) never moves. The next pass rebuilds the identical oversized filter over the identical range and fails identically. Nothing backs off, chunks, or degrades.

What keeps this at medium rather than higher, and the reporter had it right: `updateConfirmationsAndPromote(head)` runs at :449, BEFORE the scan, so confirmations keep advancing and already-detected payments still promote and still enqueue sweeps. Only detection of NEW token deposits via polling stops — and the WS fast path (:299-387) keeps covering that when `BSC_WS_RPC` is configured, which is what makes it hard to spot.

The watch-set arithmetic is right (creation rate × PAYMENT_EXPIRY_MINUTES = 30, config/env.ts:73), but I cannot demonstrate the exact N at which a given BSC dataseed node rejects the request, so treat the ~1,800-address figure as indicative rather than measured.

**Fix.** backend/src/blockchain/evmListener.ts:466-509 — chunk the watch set and only advance the cursor when every slice of every asset has succeeded:
```ts
const MAX_TOPICS_PER_FILTER = 500; // module-level, next to MAX_SCAN_RANGE
…
const watched = Array.from(depositAddresses);
if (watched.length > MAX_TOPICS_PER_FILTER) {
  logger.warn({ watched: watched.length, chunk: MAX_TOPICS_PER_FILTER },
    'watch set exceeds one filter; scanning in slices');
}
for (const asset of tokenAssetsFor(cfg.network)) {
  const token = tokenContract(httpRpc, asset);
  for (let i = 0; i < watched.length; i += MAX_TOPICS_PER_FILTER) {
    const slice = watched.slice(i, i + MAX_TOPICS_PER_FILTER);
    let logs: Log[] = [];
    try {
      logs = (await token.queryFilter(token.filters.Transfer(null, slice), fromBlock, scanTo)) as unknown as Log[];
    } catch (err) {
      logger.error({ err, fromBlock, scanTo, asset: asset.symbol, sliceStart: i },
        'queryFilter failed; will retry next pass');
      return; // cursor stays put — the whole range is retried
    }
    for (const raw of logs) { /* unchanged body from :487-507 */ }
  }
}
```
Also assert on the count already logged at :154 — `if (depositAddresses.size > MAX_TOPICS_PER_FILTER * 4) logger.error(...)` — so the operator learns before the RPC does. Longer term, drop the address topic entirely and filter client-side against `depositAddresses`, using the block range as the only server-side bound: that trades bandwidth for a request shape whose size does not grow with the merchant base.

### A database blip during listener startup kills the boot with one misleading log line and a zero exit code
`backend/src/blockchain/evmListener.ts:782` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** The code shape is exactly as reported, but BOTH stated failure mechanisms are wrong, and I demonstrated it.

What is true: evmListener.ts:772-777 installs the swallow-and-continue handlers, then :782 `await refreshDepositAddresses();` runs unguarded, and every `setInterval` (:783 address refresh, :793 token reconciler, :814 native) and both SIGTERM/SIGINT handlers (:830-831) are registered after it. The entrypoint is `void runEvmListener(BSC)` (listener.ts, last line). Same shape at tronListener.ts:558 and bitcoinListener.ts:286.

What is FALSE — claim 1, 'the process runs forever doing nothing'. I built a faithful repro (the repo's own `pg`, an unreachable DSN, the same two handlers installed before the await, `void run()`), ran it on Node 24.19.0, and got:
  unhandledRejection (listener continues): Error: connect ECONNREFUSED …
  PROCESS EXITED code= 0 after ms= 3
Nothing keeps the loop alive: the two `httpProviderFor` calls at :779-780 use `staticNetwork: true` so they issue no request and install no poller, and the failed `pool.connect()` leaves no idle client.

What is FALSE — claim 2, '`restart: unless-stopped` treats exit 0 as a clean stop'. It does not. `unless-stopped` restarts the container on ANY exit code; only `on-failure` ignores 0. The pm2 path (deploy-crypto-gateway.sh:300-320) likewise defaults to `autorestart: true` for every exit code. So both supervisors restart the listener and the system self-heals once Postgres returns.

What remains, and why this is still worth fixing: the one line it prints says 'listener continues' when it demonstrably does not; the exit code is 0, so no supervisor can distinguish a boot failure from a clean stop; and because the exit happens in ~3ms, a Postgres outage produces a very tight restart loop that can trip pm2's unstable-restart guard (`min_uptime` 1000ms / `max_restarts` 16 by default) and leave cg-listener in `errored` state, which pm2 will not restart. That last path is real but I could not exercise pm2 here, so I am not claiming it as demonstrated.

**Fix.** (1) Make the failure visible and the exit code honest. backend/src/blockchain/listener.ts — replace `void runEvmListener(BSC);` with:
```ts
runEvmListener(BSC).catch((err) => {
  logger.fatal({ err }, 'BSC listener failed to start');
  process.exit(1);
});
```
Same for ethListener.ts:27 and the `void main()` at tronListener.ts:585 and bitcoinListener.ts:313.
(2) Remove the failure entirely by not awaiting the initial load. In evmListener.ts, delete the bare `await refreshDepositAddresses();` at :782 and let the interval at :783-787 do the first load — it already has a `.catch`. Then call it once immediately: `void refreshDepositAddresses().catch((err) => logger.error({ err }, 'initial address refresh failed; the 30s timer will retry'));`. The timers are registered first, so a DB blip costs one skipped refresh instead of the whole process. Same at tronListener.ts:558 and bitcoinListener.ts:286.
(3) Add a liveness signal that distinguishes 'alive' from 'reconciling'. Write `chain_cursor.updated_at = now()` on every completed pass (the UPDATEs at evmListener.ts:513-516, tronListener.ts:534-537, bitcoinListener.ts:261-263 already run there) and expose a `/ready` on the API that fails when any enabled network's cursor is stale. That is the same heartbeat the missing-eth/btc-listener finding needs, so build it once.

### Neither the API nor the worker guards its boot path; a Redis outage at worker startup produces a live process that registers no workers at all
`backend/src/workers/index.ts:367` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** The factual claims hold; the stated impact does not, but I found a worse concrete failure at the same lines, which is why this lands at medium rather than low.

CONFIRMED FACTS. I grepped all of backend/src for `process.on(` — the only hits are the three listeners (evmListener.ts:772/775, tronListener.ts:551/554, bitcoinListener.ts:279/282) and SIGTERM/SIGINT handlers. index.ts and workers/index.ts have neither `unhandledRejection` nor `uncaughtException`. Node 24.19.0 defaults to `--unhandled-rejections=throw`: `node -e "Promise.reject(new Error('boom'))"` prints a raw stack and exits 1. workers/index.ts:367-369 awaits three schedule calls unguarded inside `main()`, invoked as `void main()` at :381, while index.ts:93-97 wraps the equivalent call properly.

OVERSTATED. The secret-leakage angle does not survive contact: logger.ts:12-32 redacts `api_secret_hash`, `privateKey`, `mnemonic` etc., but a decrypted secret would have to be attached to a thrown Error to leak, and neither auth.ts:216 (`decrypt(row.api_secret_hash)`) nor hdwallet.ts:87 (`node.privateKey`) constructs an Error carrying the value. Losing one structured fatal line is real but is observability, not availability — Node already exits non-zero and both supervisors restart.

THE REAL PROBLEM AT workers/index.ts:367. If Redis is unreachable when the worker boots, `scheduleExpiryJob()` does not reject — it HANGS, forever. `expiryQueue.add` awaits `connection.client` = `initializing` = `init()`, which awaits `RedisConnection.waitUntilReady` (bullmq redis-connection.js:120-157). That promise resolves only on `'ready'` and rejects only on `'end'`; ioredis with BullMQ's default retryStrategy (redis-connection.js:48-51) reconnects forever and never reaches `'end'`, and `enableReadyCheck: false` (db/redis.ts:48) means no `'ready'` without a live socket. So `main()` never reaches `startWorkers()` at :370. The process logs 'starting workers' (:366) and then consumes nothing — no sweeps, no payouts, no webhooks, no expiry — with no error, no crash, and no non-zero exit. That is a silent total worker outage, and it is the exact same shape as the listener Redis hang.

**Fix.** (1) backend/src/workers/index.ts — guard the entrypoint and bound the boot. Replace `void main();` at :381 with `main().catch((err) => { logger.fatal({ err }, 'worker failed to start'); process.exit(1); });`, and wrap the three schedule calls at :367-369 so a hang becomes a restartable failure:
```ts
const BOOT_TIMEOUT_MS = 20_000;
await Promise.race([
  Promise.all([scheduleExpiryJob(), scheduleSettleJob(), scheduleSubscriptionJob()]),
  new Promise((_, rej) => setTimeout(() => rej(new Error('repeatable job scheduling timed out — is Redis reachable?')), BOOT_TIMEOUT_MS)),
]);
```
Better still, move the schedule calls AFTER `startWorkers()` so a Redis blip cannot prevent the workers from ever being constructed — they are idempotent by jobId (queues.ts:96, :115, :140) and can be retried.
(2) Add fatal handlers to both entrypoints, before `start()` / `main()` is invoked — backend/src/index.ts around :140 and backend/src/workers/index.ts around :381:
```ts
process.on('unhandledRejection', (reason) => { logger.fatal({ reason }, 'unhandledRejection'); process.exit(1); });
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaughtException'); process.exit(1); });
```
Log AND exit — unlike the listeners' swallow-and-continue. Every intentional fire-and-forget in this codebase already carries its own `.catch()` (verified across listeners, routes and services), so an unhandled rejection here is by definition unanticipated.

### A hard-coded 20-connection pool with a 10-second acquire timeout and no env override
`backend/src/db/pool.ts:14` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** The configuration facts are right; the oversubscription arithmetic is wrong for the actual topology, and the '1,000 concurrent → wall of 500s' conclusion is not demonstrated.

CONFIRMED. db/pool.ts:14-19 fixes `max: 20`, `idleTimeoutMillis: 30_000`, `connectionTimeoutMillis: 10_000`, with no env override — I grepped config/env.ts for DB_POOL and found nothing. And `connectionTimeoutMillis` really does govern the ACQUIRE, not just the connect: pg-pool/index.js:206-232 arms `setTimeout(… response.callback(new Error('timeout exceeded when trying to connect')), this.options.connectionTimeoutMillis)` on the pending queue when the pool is at max. So saturation surfaces as a 10-second hang followed by a 500.

WRONG. 'the documented topology of api + worker + 4 listeners is already 6 × 20 = 120 > 100.' Only four backend services exist (docker-compose.yml:30, :42, :53, :66) and only four pm2 apps (deploy-crypto-gateway.sh:302-318) — no eth or btc listener runs at all, which is its own finding. That is 4 × 20 = 80, under postgres:16-alpine's default `max_connections = 100`. And node-postgres pools are lazy: `max` is a ceiling, not a preallocation. The listeners run strictly serialised passes (evmListener.ts:793-801) and the worker's queries are short, so none of them approaches 20 in practice. The >max_connections wall is reachable only via `--scale`, which the chainLock.ts header (:24-30) does document as supported — so it is a real future hazard, not a present one.

UNDEMONSTRATED. 20 connections is not inherently too few for 1,000 concurrent HTTP requests; Postgres serves short statements at very high throughput and queueing is the normal design. The actual creation-path ceiling in this system is the global `hd_counter` row lock (~125-200/s deployment-wide), which is a separate finding and is not fixed by a bigger pool.

**Fix.** (1) Make the pool configurable so each process type can be sized for its real concurrency. backend/src/config/env.ts, next to the other numeric envs: `DB_POOL_MAX: numberish(20)`, `DB_ACQUIRE_TIMEOUT_MS: numberish(2000)`, exposed as `config.db.poolMax` / `config.db.acquireTimeoutMs`. Then backend/src/db/pool.ts:14-19: `max: config.db.poolMax, connectionTimeoutMillis: config.db.acquireTimeoutMs`. Set `DB_POOL_MAX=4` for the listener and worker services in docker-compose.yml and in the pm2 `env` blocks; leave the API higher.
(2) Lower the acquire timeout to ~2000ms as above. Failing fast under saturation is strictly better than holding a socket for ten seconds — ten seconds is longer than any sane client timeout, so callers currently see hung requests before they see errors.
(3) Before anyone runs `--scale api=N`, put PgBouncer in transaction pooling mode in front of Postgres and point `DATABASE_URL` at it. That decouples application pool sizing from `max_connections` entirely. Add an explicit connection budget comment next to the compose services (`4 services × DB_POOL_MAX ≤ max_connections − 3 reserved`) so the arithmetic is visible to whoever scales it next.

### Native and BTC sweeps pay their fee out of the swept amount, so the payout gross is less than what was credited and the difference accrues forever as a withdrawable balance
`backend/src/workers/index.ts:140` — money — status: DOWNGRADED

**Evidence.** The mechanism is real and permanent — I verified every step. evmAdapter.ts:224 `const fee = NATIVE_TRANSFER_GAS * gasPrice`, :234 `const value = balance - fee`, :246-257 returns `amount: formatEther(value)`. bitcoinAdapter.ts:202 `const fee = BigInt(Math.ceil(vsize * rate))`, :210 `const value = total - fee`, :230 returns `amount: satsToBtc(value)`. workers/index.ts:98 destructures that into `balanceHuman` and :140-151 passes it as the payout `amount`, which becomes `gross_amount` (payoutService.ts:198). The credited side is `amount_received`, the full pre-fee sum (evmListener.ts:256-264 via RECEIVED_SUM at :88-94). getBalanceWith computes `available = SUM(amount_received of confirmed/swept) - SUM(gross_amount of active payouts)` (payoutService.ts:468-487), so exactly one transfer fee is left behind as available balance per native/BTC payment, permanently, with nothing behind it. Token sweeps are unaffected because the adapter moves the full balance (evmAdapter.ts:332-334). Nothing anywhere writes the residue off.

DOWNGRADED from high on magnitude. The residue is exactly one on-chain transfer fee per payment, not a proportion of value: ~0.000001 BNB at 21,000 gas x 0.05 gwei (the figure assets.ts:227-229 itself cites), ~2,200 sat on BTC, ~0.0004 ETH. The auditor's '100,000 BTC payments/day -> 2.2 BTC/day' reads the stated load as 100,000 payments; the brief says 100,000 COINS of value per day. At a realistic native payment count this is single-digit dollars per day of operator-funded liability. It is a genuine, monotonically accumulating, silently-withdrawable ledger leak — which is why it is medium and not low — but it is not a high-severity money mover, and on BTC it is currently moot because no BTC payout can execute at all (see `no-decimal-validation-against-asset`).

**Fix.** Record the fee instead of letting it vanish.
(1) backend/src/blockchain/networks.ts:71-78 — add `fee?: string` to `SweepResult`.
(2) Populate it: backend/src/blockchain/evmAdapter.ts:257 return `{ txHash: tx.hash, amount: sweptHuman, asset: asset.symbol, fee: formatEther(fee) }`; backend/src/blockchain/bitcoinAdapter.ts:230 return `{ ..., fee: satsToBtc(fee) }`.
(3) backend/src/workers/index.ts:140-151 — call requestPayout with the GROSS and the fee, so the ledger balances:
  amount: fromAccountingUnits(toAccountingUnits(balanceHuman) + toAccountingUnits(result.fee ?? '0')),
  estimatedNetworkFee: result.fee ?? '0',
With `network_fee_payer='client'` (the schema default, sql/schema.sql:626), commissionService.ts:283-285 then deducts it from the merchant's net and `gross_amount` matches `amount_received` exactly, driving the residue to zero. This also fixes `network-fee-payer-is-dead-config` on the sweep leg.
(4) When `network_fee_payer='admin'` the operator intentionally absorbs it — in that case insert a compensating `blockchain_transactions` row with `direction='sweep_fee'` (add to the direction enum) so the shortfall is recorded rather than merely absent, and exclude that direction from getCommissionBalance's `collected`.
(5) Add a reconciliation assertion to the settle tick: for any `swept` payment, `amount_received - COALESCE(payout.gross_amount,0) - COALESCE(sweep_fee,0)` must be 0; log ERROR when it is not.

### `estimatedNetworkFee` is supplied only by the admin manual-payout endpoint, so on every automatic settlement the fee is 0 and `network_fee_payer='client'` has no effect
`backend/src/services/payoutService.ts:139` — money — status: CONFIRMED

**Evidence.** Verified by grepping every call site. `computeSplit(input.amount, commission, input.estimatedNetworkFee ?? '0')` at payoutService.ts:136-140. The four callers of requestPayout are workers/index.ts:140 (post-sweep auto), workers/index.ts:246 (settle tick), routes/payouts.ts:94 (merchant-initiated) — none pass estimatedNetworkFee — and routes/admin.ts:618-626, which passes it from `AdminPayoutSchema`'s optional `estimatedNetworkFee: z.string().optional()` (admin.ts:605), i.e. a field an operator types by hand. So `feeU` is 0 on every real payout and the `if (feePayer === 'client') netU -= feeU` branch (commissionService.ts:283-285) subtracts nothing.

The setting is live in the product: `network_fee_payer fee_payer NOT NULL DEFAULT 'client'` (sql/schema.sql:626) and the admin panel renders it as an editable select (admin-panel/src/components/CommissionEditor.tsx:251-252, listed as a column in Commissions.tsx:82-87). So the operator is shown a control that does nothing. `network_fee` is written as 0 on every payouts row, and getCommissionBalance (adminCommissionService.ts:79-96) has no notion of gas spend at all, so reported commission is gross of a cost that is never subtracted anywhere. Correctly medium: no funds are lost or misdirected, but reported margin is fictional.

**Fix.** (1) Sweep leg — free, and shared with `native-sweep-fee-phantom-balance`: surface `SweepResult.fee` (networks.ts:71-78, populated at evmAdapter.ts:257 and bitcoinAdapter.ts:230; for token sweeps use the gas top-up already computed at evmAdapter.ts:351 `requiredGasTopup`) and pass it as `estimatedNetworkFee` from workers/index.ts:140.
(2) Payout leg — add `estimateTransferFee(asset: string): Promise<string>` to `ChainAdapter` (blockchain/networks.ts:88), implemented per chain from the `getFeeData()` / `feeRateSatPerVb()` calls the adapters already make (evmAdapter.ts:215-224, bitcoinAdapter.ts:277). Have requestPayout call it when `estimatedNetworkFee` is not supplied, instead of defaulting to '0'.
(3) The fee is paid in BNB/ETH/TRX/BTC but deducted from a settlement asset, so cross both legs through USD with `estimateFiat` (services/rateService.ts:585) and persist the rate used on the payouts row (add `fee_rate NUMERIC(38,18)` and `fee_rate_source TEXT` in a new migration) so the deduction is auditable.
(4) If (2)+(3) is judged too much for now, the honest interim is to remove the fee-payer control from admin-panel/src/components/CommissionEditor.tsx and default the column to 'admin', so the product stops claiming a behaviour it does not have.

### `reconcilePaidInvoices` marks an invoice `paid` whenever a payment on its link confirms, with no comparison against the invoice total
`backend/src/services/invoiceService.ts:693` — money — status: DOWNGRADED

**Evidence.** The missing predicate is real: invoiceService.ts:694-705 is a single UPDATE whose only conditions are `l.id = i.payment_link_id AND i.status='open' AND p.status IN ('confirmed','swept')`. `i.total` is never compared against `p.amount`, `p.amount_received` or `p.fiat_amount`, and the currency is never compared. It stamps paid_at and fires an `invoice.paid` webhook (line 712), inside a try/catch that only logs (workers/index.ts:275-281).

DOWNGRADED from high because it has NO independent failure mode. I checked the second half of the auditor's claim — 'the join is loose, so if a link were ever reusable the first payment of any size closes the invoice' — and invoice links are minted `reusable=false, max_uses=1` (invoiceService.ts:396-411), with the use claimed under `FOR UPDATE OF l` at payment-creation time (paymentLinkService.ts:352-379, called from routes/paymentLinks.ts:174 inside the same transaction as createPayment). So exactly one payment can ever exist per invoice link, and its amount is derived from the invoice total via the frozen quote (routes/paymentLinks.ts:189-200 -> paymentService.ts:197-221). The only way the invoice total and the paid amount can diverge is `underpayment-confirms-in-full`. Fixing that fixes this. It remains worth closing as defence in depth, and the missing currency comparison is a genuine (if currently unreachable) hole, hence medium rather than refuted.

**Fix.** Add the predicate to the UPDATE at backend/src/services/invoiceService.ts:695-705. The comparison is possible because the payment carries its own frozen quote — `payments.fiat_amount` / `fiat_currency` are written once at paymentService.ts:259-286 and, as the comment there states and I confirmed by grep, nothing ever UPDATEs them:

  AND (
    (p.fiat_currency IS NOT NULL
       AND p.fiat_currency = i.currency
       AND p.fiat_amount >= i.total)
    OR
    (p.fiat_currency IS NULL AND p.amount_received >= p.amount)
  )

Once the listeners set `partial` (see `underpayment-confirms-in-full`), `p.status IN ('confirmed','swept')` already excludes short payments and this becomes belt-and-braces — which is the right relationship, not the only guard. Add an `invoice.underpaid` event so a short payment against an invoice is reported rather than silently leaving the invoice open with a spent single-use link and no way for the customer to pay the balance (that dead end is worth fixing at the same time: allow a `partial` payment's link to be re-opened, or mint a top-up link).

### The admin client list computes each merchant's `available` balance as a JS float over a cross-asset, cross-network SUM
`backend/src/services/adminClientService.ts:136` — money — status: CONFIRMED

**Evidence.** Verified verbatim. adminClientService.ts:136-138: `const volume = Number(row.volume) || 0; const paidOut = Number(row.paid_out) || 0; const available = volume - paidOut;`, rendered at line 172 as `availableBalance: String(available < 0 ? 0 : available)`. Both inputs come from aggregates grouped only by client_id — adminClientService.ts:118-122 `SELECT client_id, SUM(amount_received) AS volume FROM payments WHERE status IN ('confirmed','swept') GROUP BY client_id` and 128-132 `SELECT client_id, SUM(net_amount) AS paid_out FROM payouts WHERE status IN ('sent','confirmed') GROUP BY client_id`. No network filter, no asset filter. So BTC + ETH + BNB + USDT + USDC are added as if fungible. I confirmed the float loss: `Number('123456789.123456789012345678')` returns 123456789.12345679.

The two-definitions problem is real too: this uses `net_amount` and `('sent','confirmed')` while the authoritative guard uses `gross_amount` and `('pending','processing','sent','confirmed')` (payoutService.ts:481-485) — the same named quantity computed two different ways.

Severity held at medium, not raised: this figure gates nothing in code. The payout guard is getBalanceWith (payoutService.ts:438-495), which is correctly per-(network, asset) and in BigInt. The exposure is an operator making a manual-payout decision on a meaningless number, plus the availability cost — CLIENT_SELECT (line 80-133) runs both whole-history GROUP BYs on EVERY admin client-list page load AND on every single-client fetch (getAdminClient, line 178-183), with no date bound and no index leading on `status` (idx_payments_client_network_asset_status leads with client_id, sql/schema.sql:366).

**Fix.** Reuse the correct implementation instead of maintaining a second one.
(1) backend/src/services/adminClientService.ts — drop the `vol` and `po` LEFT JOINs (lines 118-132) and the float arithmetic (136-138). Return a per-(network, asset) breakdown by calling the existing `getAllBalances(clientId)` (payoutService.ts:375-426), which already does this aggregation grouped by (network, asset) with BigInt arithmetic and the same exclusions as the payout guard. Change `AdminClient.availableBalance: string` (line 47) to `balances: Array<{network, asset, available, pending}>`.
(2) For the list view, N calls to getAllBalances is N+1 — instead lift its CTE into a single grouped query keyed by the page's client ids (`WHERE client_id = ANY($1)`).
(3) If one headline figure is genuinely wanted, compute it as a USD estimate via `estimateFiat` (services/rateService.ts:585) and name the field `approxUsd`, following the precedent already set at routes/account.ts:889-896 where the cross-asset sums are explicitly named `settledVolumeApprox` / `inFlightAmountApprox`.
(4) Update admin-panel/src/types.ts and the Clients page to render the breakdown.

### The operator's revenue dashboard sums commission and volume across every asset and network, and books unsettled payouts as revenue
`backend/src/routes/admin.ts:780` — money — status: CONFIRMED

**Evidence.** Verified with one correction to the auditor. The cross-asset claim is exactly right: admin.ts:779-791 computes total_volume, today_revenue, total_revenue and total_commission with no GROUP BY and no asset or network filter; the 30-day timeseries (admin.ts:801-834) is the same; byNetwork (admin.ts:870-886) groups by network but still mixes assets within a chain. The status-filter defect is confirmed and is the sharpest part: `today_revenue` is `SUM(commission_amount) FROM payouts WHERE created_at >= date_trunc('day', now())` with NO status filter (line 782-783) and `total_commission` is `SUM(commission_amount) FROM payouts` with no filter at all (line 786) — so a `failed` payout and the replacement row the settle tick creates for it (see `failed-payout-releases-balance`) both count, double-booking the commission. The timeseries `po` CTE (817-824) has the same omission.

CORRECTION: the auditor wrote that the values 'are then converted with Number(...) before serialisation'. That is true only for networkBreakdown (admin.ts:896-902), timeseries (903-909) and clientBreakdown (910-915). The headline totals at admin.ts:889-895 are returned as STRINGS (`totalVolume: totals?.total_volume ?? '0'`), so the float loss does not affect them. The asset-mixing and status-filter defects do.

Held at medium: no money moves on these numbers, but they are the business's reported revenue, and the queries are unbounded whole-table aggregates on payments and payouts executed on every dashboard load against the same 20-connection pool (db/pool.ts:16) the payment API uses.

**Fix.** backend/src/routes/admin.ts:
(1) Add `WHERE status IN ('sent','confirmed')` to the today_revenue (line 782-783) and total_commission (line 786) subqueries and to the timeseries `po` CTE (817-824). This is the one-line correctness fix; do it first.
(2) Add `GROUP BY network, asset` to the totals query (770-791) and the timeseries (794-834) and return arrays of per-asset figures rather than scalars, mirroring the `byAsset` breakdown routes/account.ts:828-841 already returns correctly for merchants.
(3) Remove the `Number(...)` casts at admin.ts:898-914 and let the panel format decimal strings — the payments list at admin.ts:508 already does this correctly. Update admin-panel/src/types.ts accordingly.
(4) If a single cross-asset headline is required, convert each asset's figure through `estimateFiat` (rateService.ts:585) and label it explicitly as an estimate.
(5) New migration for the aggregate shapes, which have no supporting index today:
  CREATE INDEX idx_payments_settled_created ON payments(created_at) WHERE status IN ('confirmed','swept');
  CREATE INDEX idx_payouts_settled_created ON payouts(created_at) WHERE status IN ('sent','confirmed');

### One slow merchant endpoint blocks every merchant's webhooks, and webhook_logs grows without any retention policy
`backend/src/workers/index.ts:297` — scale-and-load — status: DOWNGRADED

**Evidence.** Both halves verified. Queue: workers/index.ts:297-301 creates a single webhook Worker with `{ connection, concurrency: 10 }` for all merchants, with no group key, no per-client fairness and no circuit breaker; queues.ts:27-32 sets `attempts: config.webhook.maxRetries` (WEBHOOK_MAX_RETRIES default 8, config/env.ts:257) with `backoff: {type:'exponential', delay: 5_000}`; webhookService.ts:194 aborts at config.webhook.timeoutMs (default 8000, env.ts:258). Storage: webhookService.ts:236-246 INSERTs a brand-new row for every attempt beyond the first via a self-referencing `INSERT ... SELECT`, carrying the full jsonb payload, and :212/:215 store up to 4000 characters of response body. I grepped the whole tree and sql/ for DELETE FROM webhook_logs, retention, prune and PARTITION — zero hits. Event count per payment confirmed at 4-5: paymentService.ts:295, evmListener.ts:274, evmListener.ts:643, workers/index.ts:128, payoutService.ts:309.

DOWNGRADED because the head-of-line half is less acute than stated. BullMQ delayed jobs do not occupy worker slots, and with exponential backoff from 5 s the retry schedule for a dead endpoint is 5/10/20/40/80/160/320 s — so a failing merchant burns the 10 slots in waves rather than continuously, and the 1.25 deliveries/second figure is a worst-case instantaneous floor, not a sustained drain rate. Average demand at 100k coins/day is well under that. The storage half is the solid part: unbounded, unpartitioned, unpruned growth of the fastest-growing table in the database, multiplied 8x for every failing endpoint, with the admin viewer seq-scanning and sorting it (admin.ts:687).

**Fix.** Queue: raise webhook concurrency at workers/index.ts:300 to 50 (it is pure I/O; the 8 s AbortController timeout bounds each slot). Add a Redis circuit breaker in webhookService.dispatch: before the fetch at :201, `if (await redis.get('wh:open:'+clientId)) throw new Error('circuit open')`, and on a failure streak of 5 set that key with `EX 300`. That is what actually stops one dead endpoint from consuming slots, and it needs client_id selected in the dispatch query at :173-180. Storage: stop inserting a row per attempt — replace the else-branch INSERT at :237-245 with `UPDATE webhook_logs SET attempt = $2, status_code = $3, success = $4, response_body = $5, next_retry_at = $6, attempts_log = COALESCE(attempts_log,'[]'::jsonb) || $7::jsonb WHERE id = $1` after adding an `attempts_log JSONB` column. Cap response_body at 512 chars (change the two `.slice(0, 4000)` at :212 and :215). Then convert webhook_logs to `PARTITION BY RANGE (created_at)` monthly and add a job that drops partitions older than 90 days.

### Every authenticated API request fires an UPDATE against the same api_keys row and consumes a second pool connection
`backend/src/middleware/auth.ts:149` — scale-and-load — status: CONFIRMED

**Evidence.** middleware/auth.ts:148-151 confirmed verbatim: `query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.api_key_id]).catch((err) => logger.warn(...))` on every successful authentication, in addition to the SELECT at :168 or :179. No throttle, no coalescing, no cache of the key lookup — every authenticated request costs two pool acquisitions before the route body runs, against max 20 (db/pool.ts:16). The swallowed .catch is real: under pool saturation these rejections become invisible.

One mechanism correction: 'three indexes that all get churned' is wrong. api_keys carries idx_api_keys_client(client_id), idx_api_keys_key(api_key) WHERE status='active' and idx_api_keys_token_hash (sql/schema.sql:216-218), and last_used_at appears in none of them — so Postgres performs a HOT update and touches no index at all as long as the page has free space. The valid, verified cost is the extra pool acquisition and the extra tuple version per request on a small hot table. Kept at medium: at 250 concurrent per instance it doubles the auth layer's demand on a 20-slot pool, which is exactly the saturation path the pg-pool finding describes.

**Fix.** Two changes in middleware/auth.ts. (1) Throttle the write: wrap line 149 in `if (await redis.set('ku:'+row.api_key_id, '1', 'EX', 60, 'NX')) { query(...).catch(...) }` so last_used_at is written at most once per key per minute — a minute of resolution is more than the column's purpose requires. (2) Cache the lookup: in lookupByPublicId (:167) and lookupByToken (:178), check `redis.get('apikey:'+sha256Hex(presented))` first and `SETEX` the resolved ApiKeyRow for 30 s on a miss. That removes the SELECT from nearly every request. Invalidate explicitly with `redis.del('apikey:'+...)` inside apiKeyService.revokeApiKey and wherever clients.status or ip_whitelist changes, and keep the TTL at 30 s so a missed invalidation self-heals fast — a revoked key staying live for half a minute is the cost, and it must be a deliberate, documented one.

### The expiry tick expires an unbounded number of payments in one statement and fans out a webhook enqueue per row
`backend/src/workers/index.ts:165` — scale-and-load — status: CONFIRMED

**Evidence.** workers/index.ts:165-183 confirmed: `UPDATE payments SET status='expired' WHERE status='waiting' AND expires_at < now() RETURNING id` with no LIMIT, then a loop over every returned id calling enqueueWebhook. Contrast with processSettle step 1 at :203-209 (LIMIT 500) and subscriptionService.ts:506-512, both correctly bounded. The 'only waiting is expired' observation is correct — confirming and partial are never aged out, while all three listeners' watch sets include them (evmListener.ts:147, tronListener.ts:140, bitcoinListener.ts:65).

The failure mechanism in the finding is wrong, and the corrected one is worse. enqueueWebhook at :176-180 is NOT awaited — it is fire-and-forget with `.catch(...)`. So processExpiry returns almost immediately, the BullMQ job never approaches lockDuration (verified as 30_000 with lockRenewTime = lockDuration/2 and automatic renewal, node_modules/bullmq/dist/cjs/classes/worker.js:34,64), the job is not declared stalled, and there are no duplicate expired events. What actually happens after an outage: N detached promises fire at once, each needing 2 pool connections (webhookService.ts:82 and :145). With N in the thousands against max 20 and connectionTimeoutMillis 10_000, most reject with 'timeout exceeded when trying to connect' — swallowed by the .catch at :180, so merchants silently never receive payment.expired — while the WORKER process's pool is pinned for 10 s, starving the sweep, payout and settle jobs that share it. The UPDATE itself is fine: idx_payments_expires is partial on `WHERE status IN ('waiting','confirming')` (sql/schema.sql:359) and serves the predicate.

**Fix.** Bound the statement exactly like processSettle step 1: `UPDATE payments SET status='expired' WHERE id IN (SELECT id FROM payments WHERE status='waiting' AND expires_at < now() ORDER BY expires_at ASC LIMIT 500 FOR UPDATE SKIP LOCKED) RETURNING id` — a backlog then drains over successive ticks. Replace the detached loop at :175-181 with awaited bounded concurrency so the pool is never stampeded and failures are observable: iterate in chunks of 5 with `await Promise.allSettled(chunk.map(r => enqueueWebhook({...})))` and log the rejected count at error level. Better still, add an `enqueueWebhooksBulk(rows)` to webhookService that does one multi-row INSERT ... RETURNING id and one `webhookQueue.addBulk(...)`, turning 3N operations into 2. Separately add the missing ageing rule so listener watch sets cannot grow without bound: a second statement expiring `status IN ('confirming','partial') AND expires_at < now() - interval '24 hours'`.

### Every payments list page runs a COUNT(*) over the merchant's whole history and paginates with OFFSET
`backend/src/services/paymentService.ts:361` — scale-and-load — status: CONFIRMED

**Evidence.** paymentService.ts:346-377 confirmed: `SELECT COUNT(*)::text AS count FROM payments WHERE client_id = $1 [AND status = $2]` on every call at :361-364, then `SELECT * FROM payments WHERE ... ORDER BY created_at DESC LIMIT ... OFFSET ...` at :369-373. The `SELECT *` observation is right — the DTO at :380-413 uses a subset and the row drags back five fiat columns plus NUMERIC(38,18) values. The limit IS clamped to 100 at :350, so the page itself is bounded; the unbounded costs are the COUNT and the OFFSET depth. The same COUNT-then-OFFSET shape is repeated at admin.ts:470/497, admin.ts:546/571 and adminClientService.ts:209/220 as claimed.

One correction that softens the mechanism: 'COUNT(*) must visit every matching row — it cannot be answered from the index alone' is not right. Postgres can serve it as an index-only scan over idx_payments_client (or idx_payments_client_created) wherever the visibility map marks pages all-visible, which for a mostly-append table is most of the history. The cost is still O(rows in the client slice) but in index pages, not heap pages — roughly an order of magnitude less than stated. Medium is the right level: it grows without bound and is paid on page 1, but it is not the fastest path to pool exhaustion here.

**Fix.** In paymentService.ts:346-377: drop the exact total by default — fetch `limit + 1` rows and return `hasMore: rows.length > limit` instead of running the COUNT at :361, and only compute the exact count when the caller passes `?count=exact`. Switch to keyset pagination for depth: accept an opaque cursor and use `WHERE client_id = $1 [AND status = $2] AND (created_at, id) < ($cursor_created_at, $cursor_id) ORDER BY created_at DESC, id DESC LIMIT $n`, which is O(limit) at any page. Replace the `SELECT *` at :369 with the explicit column list toDTO actually reads (id, order_id, amount, amount_received, currency, asset, network, deposit_address, status, confirmations, tx_hash, expires_at, created_at, fiat_currency, fiat_amount, fiat_rate, rate_source, rate_locked_at). Back it with idx_payments_client_status_created from the missing-indexes migration.


## LOW

### Outbound webhook signatures carry no timestamp or nonce
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/services/webhookService.ts:55` — authsec — status: DOWNGRADED

**Evidence.** The facts hold: canonicalBody (webhookService.ts:55-65) fixes the signed payload as { event, paymentId, orderId, amount, txHash, status, signature } with no timestamp, delivery id or nonce, and delivery sends only `x-gateway-signature` and `x-gateway-event` (webhookService.ts:203-207) — no x-gateway-timestamp, unlike the inbound scheme's 300s window at auth.ts:199-206. But the consequence is overstated and the supporting claim is backwards. docs/sdk/javascript.md:255-259 tells receivers verbatim to 'process idempotently (you may receive retries)' and to 'fulfill the order here; make it idempotent on parsed.paymentId' — the opposite of the per-delivery crediting the finding assumes — and paymentId plus event are both inside the signed body, so a receiver following the shipped guidance is immune to replay by construction. The second sub-claim is REFUTED outright: `signature: ''` at webhookService.ts:139 is unreachable, because both and only both client-creation paths write an encrypted secret (routes/admin.ts:169-183 `encrypt(randomToken(24))` and routes/register.ts:168-181 the same), so clients.webhook_secret is never NULL in practice despite being nullable in sql/schema.sql. Residual risk is a non-compliant receiver, which makes this a hardening item.

**Fix.** backend/src/services/webhookService.ts:55-65 — extend the canonical payload with `deliveryId` (the webhook_logs row id, already unique per attempt because retries INSERT a new row at line 237-245) and `issuedAt` (unix seconds), and emit them at line 203 as `x-gateway-delivery` and `x-gateway-timestamp` alongside the existing headers. Ship the new body shape under `x-gateway-signature-v2` while continuing to send the current header for one deprecation cycle so existing receivers keep verifying, and update docs/sdk/{javascript,php,python}.md to require rejecting a delivery whose issuedAt is more than 300s old and to dedupe on deliveryId — mirroring the inbound rule at middleware/auth.ts:204. Note the constraint in the header comment at webhookService.ts:32-54: whatever you add must go through canonicalBody and must never be re-serialized from the jsonb column, or you reintroduce the key-ordering bug that comment documents. Optionally tighten webhookService.ts:139 to throw rather than sign with '' — defence in depth against a future path that inserts a client row without a secret.

### The HMAC covers an empty body whenever the Content-Type is not application/json
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/index.ts:48` — authsec — status: DOWNGRADED

**Evidence.** Mechanically correct: index.ts:48-55 populates req.rawBody only from the `verify` hook of express.json(), whose `type` option defaults to application/json, so body-parser skips verify entirely for any other Content-Type; middleware/auth.ts:222 then silently degrades to `const rawBody = req.rawBody ? req.rawBody.toString('utf8') : ''` and reports success. This is a genuine fail-open in a signature verifier. But it grants no capability today beyond the replay finding it amplifies, and both precedents the auditor cites are wrong: account.ts:144 (`CreateKeySchema.parse(req.body ?? {})`) sits behind requireDashboardSession (account.ts:141), so an HMAC key cannot reach it, and paymentLinks.ts:167 is the unauthenticated public checkout, which is not signed at all. The two HMAC-reachable handlers that do use `req.body ?? {}` both have required fields — invoices.ts:47-49 requires currency and a non-empty items array, subscriptions CreateSchema likewise — so an empty body 400s at zod (body-parser sets `req.body = {}` when it skips, it does not leave it undefined). So the exploitable set is exactly the no-body routes already covered by hmac-no-replay-no-binding, and it still requires a captured signature.

**Fix.** backend/src/middleware/auth.ts:222 — fail closed rather than defaulting. Before computing the digest: `const declaredLength = Number(req.headers['content-length'] ?? 0); if ((declaredLength > 0 || req.headers['transfer-encoding']) && !req.rawBody) throw AppError.unauthorized('Request body was not covered by the signature — send Content-Type: application/json');` and additionally reject any signed request whose content-type is present and is not application/json, since that is the only body format the merchant API parses. Belt and braces in backend/src/index.ts:48-55: capture raw bytes for every content type by adding `app.use(express.raw({ type: '*/*', limit: '256kb', verify: (req, _res, buf) => { (req as express.Request).rawBody = Buffer.from(buf); } }))` after the json parser, so rawBody is always populated and the check above becomes belt-only. Fixing this is a prerequisite for the method/path binding change in hmac-no-replay-no-binding, since that hashes rawBody.

### The AES-GCM envelope carries no key id, so MASTER_ENCRYPTION_KEY cannot be rotated
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/utils/crypto.ts:24` — authsec — status: DOWNGRADED

**Evidence.** The format is confirmed: utils/crypto.ts:24-30 emits `iv:tag:ciphertext` with no version prefix, crypto.ts:36-50 splits on ':' and requires exactly 3 parts, and crypto.ts:19 derives one module-level KEY at import from config.masterEncryptionKey (validated as 64 hex at config/env.ts:59-61). There is no dual-key read path, and every at-rest secret flows through it — apiKeyService encrypt for api_secret_hash, register.ts:177 and admin.ts:182 for webhook_secret, users.mfa_secret. Rotating the value would break every stored ciphertext at once, surfacing as `AppError.internal('API key secret unreadable')` at middleware/auth.ts:216-220 (a 500 on every HMAC request) and a throw at webhookService.ts:115 killing delivery. Downgraded from medium because nothing in the product asks an operator to rotate this value, no code path rotates it, and the failure is immediate, total, obvious in the logs (auth.ts:218) and reversible in seconds by restoring the previous value — no data is lost and no funds are at risk. This is a missing capability and a latent operational trap, which is the low bar.

**Fix.** backend/src/utils/crypto.ts — change encrypt() at line 24 to emit `v1:${iv}:${tag}:${ct}` and make decrypt() at line 36 accept both shapes: a 3-part payload is key id 0 (legacy), a 4-part payload selects from a keyring. Add `MASTER_ENCRYPTION_KEY_PREVIOUS: z.string().regex(/^[0-9a-fA-F]{64}$/).optional()` to config/env.ts beside line 59 and expose it as `config.masterEncryptionKeyPrevious`; decrypt tries the id-matched key and falls back to the previous one. Add a one-shot re-encrypt script (backend/src/scripts/reencrypt.ts) that walks api_keys.api_secret_hash, clients.webhook_secret and users.mfa_secret and rewrites each under the current id, so rotation becomes: set PREVIOUS, deploy, run the script, drop PREVIOUS. Add a boot self-test in index.ts start() next to validateAssets() that encrypts and decrypts a probe string and exits non-zero on failure, matching the fail-at-boot discipline config/env.ts already applies. Do NOT take the auditor's suggestion to turn auth.ts:216-220 into a 401: an undecryptable stored secret is server-side corruption, and telling the merchant their key is invalid invites them to regenerate keys and destroy the evidence. Keep the 500, give it a distinct code ('secret_unreadable') and alert on it.

### CORS reflects any origin with credentials: true
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/index.ts:32` — authsec — status: DOWNGRADED

**Evidence.** index.ts:32-45 is exactly `cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type','Authorization','X-Api-Key','X-Timestamp','X-Signature','Idempotency-Key'] })`, with no allowlist built from config.signup.panelUrl (config/env.ts:267 PUBLIC_PANEL_URL) or config.appBaseUrl. But `credentials: true` grants ambient authority only when the browser has ambient credentials to send, and this API has none: grepping backend/src for 'cookie' returns nothing — every credential is an explicit header (Authorization, X-Api-Key) that an attacker's page cannot obtain from the victim's browser. So a drive-by origin gets exactly what curl already gets: unauthenticated responses. The residual effect is that a page which has ALREADY stolen a token can read responses directly instead of proxying through its own server, plus error text and rate-limit headers become cross-origin readable for recon. That is defence-in-depth, not medium.

**Fix.** backend/src/index.ts:32-45 — replace `origin: true` with a function checking an explicit set: `const allowed = new Set([config.signup.panelUrl, config.adminPanelUrl, config.appBaseUrl]); origin: (o, cb) => cb(null, !o || allowed.has(o.replace(/\/+$/,'')))`. Requests with no Origin (server-to-server, curl, the SDKs) are unaffected since CORS does not apply to them. Add `ADMIN_PANEL_URL: z.string().url().default('http://localhost:5173')` to config/env.ts beside PUBLIC_PANEL_URL at line 267 and expose it — the deploy script already knows both hostnames (deploy-crypto-gateway.sh:35-36). Set `credentials: false`: nothing in backend/src reads or sets a cookie, so it buys nothing today and would silently become load-bearing the moment someone introduces one.

### The IP allowlist is exact-string match only — a merchant who enters a CIDR silently locks themselves out
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/auth.ts:240` — authsec — status: CONFIRMED

**Evidence.** middleware/auth.ts:240-253 is a plain set membership test: `const candidates = new Set([ip, ip.replace(/^::ffff:/, '')]); if (allow.some((entry) => candidates.has(entry.trim()))) return;` — no CIDR parsing, no range support, and the only normalization is stripping the IPv6-mapped prefix. The write path accepts anything string-shaped: routes/account.ts:340 is `ipWhitelist: z.array(z.string().min(3).max(45)).max(50).optional()`, so '10.0.0.0/8' (9 chars) is stored verbatim by the UPDATE at account.ts:352-374 and echoed back as configured by toSettings (account.ts:295), and the admin path at admin.ts:241 is looser still (`z.array(z.string())`). Every subsequent API request from that merchant then hits auth.ts:248-252 and gets `403 Source IP is not allowed for this account`, with the only diagnostic being a server-side warn log. The product actively steers merchants toward this: account.ts:627-630 surfaces `warnings.simpleKeyWithoutIpAllowlist`. Recovery is at least reachable — PUT /account/settings is requireDashboardSession (account.ts:346), so an API key lockout does not lock the panel out too, and `ipWhitelist: []` clears it (the COALESCE note at account.ts:358-360 correctly distinguishes 'not supplied' from 'empty array').

**Fix.** backend/src/middleware/auth.ts:240-253 — build a `net.BlockList` per request (or memoize per client): for each entry, `entry.includes('/') ? bl.addSubnet(addr, Number(prefix), family) : bl.addAddress(addr, family)`, then test both `ip` and the ::ffff:-stripped form with `bl.check()`. net.BlockList is Node core, so no new dependency. Tighten the write path at routes/account.ts:340 and routes/admin.ts:241 with a `.refine` that accepts only a valid IPv4/IPv6 literal or CIDR (net.isIP for the bare case, plus a prefix-length range check), returning a readable message so a typo cannot be persisted at all. Add the caller's observed IP to the GET /account/settings response (account.ts:286-298, `observedIp: req.ip`) so a merchant configuring the list can see what the server sees through Apache's X-Forwarded-For rather than guessing.

### JWT verification does not pin the algorithm or check issuer/audience
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/jwtAuth.ts:32` — authsec — status: CONFIRMED

**Evidence.** middleware/jwtAuth.ts:32 is `jwt.verify(token, config.jwt.secret)` with no algorithms/issuer/audience, and the two sign calls (jwtAuth.ts:20, 26) set only expiresIn — no issuer, no audience, and the same config.jwt.secret for both access and refresh tokens. config/env.ts:55 floors JWT_SECRET at 16 characters. The auditor's own assessment that this is not currently exploitable is correct and I confirmed it in the installed library: jsonwebtoken 9.0.3, node_modules/jsonwebtoken/verify.js:115-117 refuses a token with no signature unless options.algorithms explicitly names it, and verify.js:126-136 defaults options.algorithms to the HS family when the key material is a secret — so neither alg:none nor an RS256->HS256 confusion works. The deployed JWT_SECRET is 64 characters, so the entropy floor is a policy gap rather than a live weakness. Latent, correctly rated low.

**Fix.** backend/src/middleware/jwtAuth.ts:32 — `jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: 'paycrypo', audience: 'paycrypo-api' })`, with the matching `issuer`/`audience` added to the sign options at lines 20-22 and 26-28. Deploy the verify side as tolerant first (accept a missing iss/aud for one release) so tokens minted before the change keep working, then tighten. Raise the floor at backend/src/config/env.ts:55 from `.min(16)` to `.min(32)`. Use a distinct key for refresh tokens: add `JWT_REFRESH_SECRET` to config/env.ts defaulting to `hmacSha256(JWT_SECRET, 'refresh')` so existing deployments do not break, and use it in signRefreshToken/verifyToken — the `type` claim is checked correctly today (jwtAuth.ts:48, clientAuth.ts:51, auth.ts:131) but separate keys make the separation structural instead of a check a new code path can forget.

### Every failed API-key authentication issues a second database query for a diagnostic message
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/middleware/auth.ts:116` — authsec — status: CONFIRMED

**Evidence.** middleware/auth.ts:109-127: on a miss the handler runs the opposite lookup (`signed ? await lookupByToken(presented) : await lookupByPublicId(presented)`) purely to choose a friendlier 401 string. apiKeyRateLimiter is chained at auth.ts:157, i.e. only on the success path, so an unauthenticated caller controls two indexed queries and two checkouts from the 20-slot pool (db/pool.ts:14) per request, bounded only by the global IP limiter — which the separate finding above shows is 120/min. The enumeration-oracle half of the claim is not practically exploitable and should not be sold as a reason to fix this: an hmac key's public id is `pk_live_` + randomToken(12) = 24 hex chars (account.ts:243, apiKeyService.createApiKey), so there is no space to enumerate, and lookupByToken hashes the whole token (auth.ts:180) so prefixes reveal nothing. The real cost is doubling the DB work on the unauthenticated failure path, exactly where the pool is already the binding constraint.

**Fix.** backend/src/middleware/auth.ts:105-127 — collapse to one query. Change KEY_SELECT's suffix to `AND (k.api_key = $1 OR k.token_hash = $2) LIMIT 1` with params `[presented, sha256Hex(presented)]`, then branch in memory: if no row, 401 'Unknown or revoked API key'; if `row.auth_mode === 'hmac'` and the request was unsigned, return the 'This key requires signed requests' message; if `row.auth_mode === 'simple'` and the request was signed, return the bearer message. That removes the round trip and — importantly — lets you add the explicit `signed === (row.auth_mode === 'hmac')` assertion that the file header at auth.ts:48-53 claims is enforced but which no code currently performs. Also mount a cheap IP-keyed limiter ahead of the lookup (or, better, fix the global limiter's skip predicate per the global-ip-limiter finding so unauthenticated traffic is still throttled while credentialed traffic is not) so probing is bounded before it reaches Postgres.

### Reorg revert cannot unwind a payment that has already been swept or paid out
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmListener.ts:714` — blockchain — status: DOWNGRADED

**Evidence.** The headline is REFUTED; one narrow sub-claim survives. (a) It is true that `windowStart = head - cfg.reorgDepth` (line 665) equals `safeHead` (line 440) computed from the same head, and that the scan only records blocks <= scanTo <= safeHead (line 456), so reconciler-discovered rows are never candidates for `block_number > $1` (line 679). But that is CORRECT, not a hole: such a row is by construction already `reorgDepth` blocks deep, i.e. past the depth this system defines as final. There is nothing for the checker to do. The auditor's demonstrated scenario ('run with BSC_WS_RPC unset ... nothing marks the row reorged') therefore describes the design working, not failing. (b) The ordering complaint (detectReorgs at 452 before the scan at 455-509) is immaterial for the same reason — reconciler rows are never eligible in any pass. (c) The detector is NOT dead: WS-recorded rows (evmListener.ts:358-377 -> recordIncoming) carry the live block number, which is > head - reorgDepth, so they are candidates for exactly reorgDepth blocks, and the revert at 713-723 correctly covers 'confirming' and 'confirmed'. (d) WHAT IS REAL: the revert's `AND status IN ('confirmed','confirming')` (line 721) cannot touch a payment already at 'swept' (workers/index.ts:120), and nothing cancels or compensates a `payouts` row. On BSC REQUIRED_CONFIRMATIONS=12 < REORG_DEPTH=15 (config/env.ts:72,330), so there is a 3-block window in which a promoted payment is still reorg-checkable and could already have been swept — narrow, since a sweep is two on-chain transactions each with `tx.wait(1)`. On Ethereum ETH_REQUIRED_CONFIRMATIONS=12 and ETH_REORG_DEPTH=12 (config/env.ts:95-96) are equal, so promotion lands exactly as the row leaves the window and the gap is unreachable there.

**Fix.** Two small, cheap changes in backend/src/blockchain/evmListener.ts detectReorgs(). (1) Extend the revert UPDATE at lines 713-723 to `status IN ('confirmed','confirming','swept')`, keeping the CASE mapping to 'waiting' — amount_received is already recomputed from RECEIVED_SUM, which now excludes the reorged row. (2) After that UPDATE, when the payment had reached 'swept', look up `payouts WHERE payment_id = $1`: cancel rows in ('pending','processing') with a guarded `UPDATE payouts SET status='failed'` and, for rows already in ('sent','confirmed'), write an operator alert row rather than silently leaving the merchant credited — the funds left the central wallet and only a human can reconcile that. (3) Structural mitigation that removes the window entirely: set REQUIRED_CONFIRMATIONS >= REORG_DEPTH on BSC (12 -> 15, or reduce REORG_DEPTH to 12 to match Ethereum), so a payment is never promoted while it is still inside the depth the checker covers.

### Gas-funding and sweep bookkeeping rows insert with a NULL log_index, so ON CONFLICT DO NOTHING can never fire
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/blockchain/evmAdapter.ts:385` — blockchain — status: CONFIRMED

**Evidence.** The structural claim is confirmed; the stated failure narrative is not reachable today. Schema confirmed: sql/schema.sql:561 `log_index INT` (nullable) and line 564 `UNIQUE (tx_hash, log_index)` — a plain UNIQUE, so under default Postgres NULL semantics two NULLs are distinct and `ON CONFLICT (tx_hash, log_index) DO NOTHING` can never match. Contrast unexpected_deposits at sql/schema.sql:588, which got it right with `log_index INT NOT NULL DEFAULT 0`. All three inserts omit the column: evmAdapter.ts:380-395 (gas_funding), tronAdapter.ts:298-305 (gas_funding), workers/index.ts:101-116 (sweep). So the idempotency guard those three lines are written to rely on is inert. However, I traced every retry path the report proposes and none produces a duplicate row: processSweep re-checks `payment.status !== 'confirmed'` at workers/index.ts:67-70 and returns; a retry that re-enters sweepDeposit finds the balance below asset.minSweep (evmAdapter.ts:338) and returns null before reaching the insert; the EVM gas insert at 380 is only reached after `fundTx.wait(1)` succeeds and is skipped on retry because `nativeBalance < topupWei` (line 359) is then false; tronAdapter.ts:297 sits after a successful waitForTx and is likewise skipped when trxBalance already covers topupSun (line 274). And a genuinely re-signed transfer produces a different tx_hash, which is a legitimately different row. So this is correctly a `low`: a missing guard and a latent risk, not a demonstrated defect.

**Fix.** Add a migration: `UPDATE blockchain_transactions SET log_index = 0 WHERE log_index IS NULL; ALTER TABLE blockchain_transactions ALTER COLUMN log_index SET DEFAULT 0, ALTER COLUMN log_index SET NOT NULL;` — matching what unexpected_deposits already does at sql/schema.sql:588, which makes the UNIQUE constraint bind. Backfilling to 0 is safe: no incoming row uses NULL (EVM tokens use the real log index, EVM native uses -1, TRC20 uses 0/-1, BTC uses vout), so the only NULLs are the sweep and gas_funding rows, which carry no log and are one-per-transaction. Then pass an explicit `log_index` of 0 at all three call sites — add the column and a `0` value to the INSERT lists at evmAdapter.ts:381-395, tronAdapter.ts:298-305 and workers/index.ts:102-116. Do not reach for `UNIQUE NULLS NOT DISTINCT`: it needs Postgres 15+ and leaves the column semantically ambiguous.

### An Ethereum token sent to a BSC deposit address is recorded nowhere, despite being recoverable
`/Users/mohit/Desktop/Work/crypto_gateway/backend/src/services/unexpectedDepositService.ts:106` — blockchain — status: CONFIRMED

**Evidence.** Confirmed on both legs. networks.ts:37-42 states BEP20 and ERC20 share BIP-44 coin type 60 so HD index N is the same address on both, and that such mis-sends are 'recoverable exactly because the address is shared'; evmAdapter.ts:272-279 repeats it; recover.ts:33-46 documents `--network=ERC20 <same index>` as the manual recovery. But detection is absent: refreshDepositAddresses filters `AND network = '${cfg.network}'` (evmListener.ts:143-149), so a BEP20-minted deposit address is never in the ERC20 listener's watch set, the ERC20 queryFilter topic list (line 471-476) never includes it, and recordIncoming is never called. And even if it were, the owner lookup in recordUnexpectedDeposit carries `AND w.network = $2` (unexpectedDepositService.ts:106) with `w.type = 'deposit'`, so it returns no row and the function returns at line 110 without writing anything. Nothing anywhere records the transfer's existence — exactly the invisible-stranded-funds failure the unexpected_deposits table was built to end.

**Fix.** Two edits. (1) In backend/src/blockchain/evmListener.ts refreshDepositAddresses (lines 143-149), when the process owns one EVM chain and the OTHER EVM chain is also enabled (`isNetworkEnabled('BEP20')` / `isNetworkEnabled('ERC20')` from networks.ts), widen the predicate to `AND network IN ('BEP20','ERC20')` — the addresses are byte-identical under coin type 60, so this costs only a larger topic list, which the chunking fix already bounds. (2) In backend/src/services/unexpectedDepositService.ts, replace `AND w.network = $2` at line 106 with a coin-type-aware match: `AND w.network = ANY($2::text[])`, passing `['BEP20','ERC20']` when the arriving network is either of those and `[network]` otherwise. Keep writing the row with the network the transfer ACTUALLY arrived on (the `network` parameter), not the wallet's minting network, so the merchant's recovery list and `recover.ts --network=` agree. The insert at 113-116 already has `ON CONFLICT (tx_hash, log_index) DO NOTHING` against a NOT NULL log_index (sql/schema.sql:588), so this is idempotent as-is.

### processExpiry expires an unbounded number of payments in one statement and then fires that many concurrent enqueueWebhook calls against a 20-connection pool
`backend/src/workers/index.ts:165` — business-logic — status: DOWNGRADED

**Evidence.** The code is exactly as described and the contrast with its sibling is real: processExpiry (workers/index.ts:165-183) runs `UPDATE payments SET status='expired' WHERE status='waiting' AND expires_at < now() RETURNING id` with no LIMIT, then loops firing enqueueWebhook WITHOUT await (:176-181), while processSettle is explicitly capped at SETTLE_BATCH_LIMIT=500 with a comment explaining why (:189-214). db/pool.ts:14-19 is `max: 20, connectionTimeoutMillis: 10_000`, and I confirmed in node_modules/pg-pool/index.js:206-231 that the timeout does apply to queued acquisitions, not just to socket setup — so the rejection the auditor describes is reachable in principle. I downgraded from medium for two reasons. First, the arithmetic: each enqueueWebhook is two short indexed queries (webhookService.ts:92-102 is a PK join; :146-149 a single INSERT). At ~3ms each with 20 connections that is roughly 6,600 queries/s, so exceeding a 10-second queue wait needs on the order of 30,000+ payments expiring in ONE tick — roughly 30x what a six-hour outage produces at the stated 100,000 coins/day (~10,000 payments/day, a minority abandoned). Second, one supporting claim is simply wrong: the workers run as their own process (`node dist/workers/index.js`, workers/index.ts:1-2) with their own Pool, so this cannot starve the API's 20 connections — they share the Postgres server, not the pool. What IS true at any batch size, and is the part worth fixing, is that a lost enqueue is unrecoverable: the status has already moved to 'expired', so the next tick's UPDATE matches nothing and the event is gone with only a logger.warn at :180. A brief Redis blip during the tick loses every payment.expired in that batch.

**Fix.** Stop deriving the event from RETURNING. Bound the UPDATE — `WHERE id IN (SELECT id FROM payments WHERE status='waiting' AND expires_at < now() ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)` (idx_payments_expires at schema.sql:359 covers it) — and re-run the tick immediately if it hit the cap. Then make the webhook recoverable rather than fire-and-forget: after the UPDATE, select expired payments that have no `payment.expired` row in webhook_logs (`WHERE p.status='expired' AND NOT EXISTS (SELECT 1 FROM webhook_logs w WHERE w.payment_id=p.id AND w.event='payment.expired') LIMIT 500`) and enqueue from that, awaiting each — so a lost enqueue is picked up on the next tick instead of vanishing. That query needs a supporting index: `CREATE INDEX idx_webhook_logs_payment_event ON webhook_logs(payment_id, event)`. Note this same expiry UPDATE is where the payment_links use_count release belongs (see 'invoice-link-burned-by-merely-starting'), so do both in one transaction.

### webhook_logs grows without bound, one row per delivery attempt, with no retention policy and no index supporting the growth
`sql/schema.sql:707` — business-logic — status: CONFIRMED

**Evidence.** webhook_logs (sql/schema.sql:707-721) stores `payload JSONB NOT NULL` per row with only two indexes: idx_webhook_logs_payment on (payment_id) and idx_webhook_logs_client on (client_id, created_at DESC) (:722-723) — nothing supports a global age-based sweep. dispatch INSERTs a NEW row for every attempt >= 2 rather than updating (webhookService.ts:236-245), deliberately, to preserve history. I grepped backend/src and sql for DELETE FROM webhook_logs, 'retention', 'pg_cron' and 'vacuum' — zero hits; there is no cleanup job, no partitioning, no TTL. The merchant read is LIMIT 100 and index-covered (routes/account.ts:938-952) so it stays fast, which is exactly why nothing surfaces the growth until disk does. Low is the right level.

**Fix.** Partition rather than delete: `CREATE TABLE webhook_logs (...) PARTITION BY RANGE (created_at)` with monthly partitions and a job that creates next month's and drops anything older than the retention window — dropping a partition is instant and produces no bloat, where a bulk DELETE on a JSONB table is the expensive option. If partitioning is too invasive for a live deploy, add `CREATE INDEX CONCURRENTLY idx_webhook_logs_created ON webhook_logs(created_at)` and a nightly settle-tick step deleting success=true rows older than 30 days and success=false older than 90, in batches of 10,000 with `DELETE ... WHERE id IN (SELECT id ... LIMIT 10000)` so it never holds a long transaction. Fix this together with the retry-ceiling change, which multiplies rows per failing endpoint.

### webhook_logs.next_retry_at is computed with a formula that does not match the actual BullMQ backoff, so the merchant dashboard shows a wrong retry time
`backend/src/services/webhookService.ts:220` — business-logic — status: CONFIRMED

**Evidence.** dispatch computes `nextRetryAt = new Date(Date.now() + Math.min(2 ** attempt, 3600) * 1000)` where `attempt = job.attemptsMade + 1` (webhookService.ts:186, :220-223). The real schedule is BullMQ's exponential from a 5,000ms base (workers/queues.ts:29), which node_modules/bullmq/dist/cjs/classes/backoffs.js:43 implements as `Math.round(Math.pow(2, attemptsMade - 1) * delay)`. After the first attempt the column says +2s while the job actually runs at +5s; after the seventh it says +128s while the job runs at +320s. The 3600 cap is unreachable because attempts stops at 8 (config/env.ts:257), and it is never applied to the queue. routes/account.ts:960-962 surfaces the column directly as `nextRetryAt`, and :947 uses its non-null-ness to label a delivery 'pending' vs 'failed', so the wrong value drives both the timestamp and the status word.

**Fix.** Extract one function — `export function webhookBackoffMs(attemptsMade: number): number { return Math.min(3_600_000, 5_000 * 2 ** (attemptsMade - 1)); }` — and use it in BOTH places: as the custom `backoffStrategy` on the webhook Worker (workers/index.ts:297-301, with `backoff: { type: 'custom' }` in queues.ts:29) and at webhookService.ts:220-223 as `new Date(Date.now() + webhookBackoffMs(attempt))`. That makes drift structurally impossible. Do it as part of the retry-ceiling fix, which replaces the backoff strategy anyway.

### createSubscription documents a guard against a past startAt but does not implement one, so a plan can be created directly into needs_attention
`backend/src/services/subscriptionService.ts:204` — business-logic — status: CONFIRMED

**Evidence.** The comment at subscriptionService.ts:204-205 reads 'A start date in the past would make the subscription immediately overdue and bill on the very next tick, which is surprising rather than useful.' The code that follows is only `const startAt = input.startAt ? new Date(input.startAt) : new Date(); if (Number.isNaN(startAt.getTime())) throw AppError.badRequest('startAt must be a valid date');` (:206-209) — a NaN check, nothing more. The value goes straight into next_run_at at :212/:229. The route schema is a bare `startAt: z.string().datetime().optional()` (routes/subscriptions.ts:45) with no minimum, and the table has no CHECK on next_run_at (sql/schema.sql:513). The far-past outcome is as described: billOne's too_far test `(next_run_at + interval * (max_cycles_behind + 1)) <= now()` (subscriptionService.ts:363-366, max_cycles_behind DEFAULT 3 at schema.sql:516-517) is true immediately and parks the plan in needs_attention (:371-374) without issuing an invoice. The near-past case bills on the very next tick, which is precisely what the comment says should not happen.

**Fix.** Implement the documented check at subscriptionService.ts:209: `if (startAt.getTime() < Date.now() - 5 * 60_000) throw AppError.badRequest('startAt cannot be in the past. Use a future date, or omit it to start now.');`. If you would rather be forgiving than strict, clamp instead — walk startAt forward in whole intervals until it is at or after now(), using the same expression already written for resume at :313-326 — but do not do both, and do not leave it silently accepting a past date and parking the plan. Add the same 5-minute floor to the zod schema so the error arrives as a 400 validation message rather than from the service.

### Two concurrent WS Transfer handlers for the same payment can both emit payment.confirming, which is undedupable given the payload
`backend/src/blockchain/evmListener.ts:271` — business-logic — status: CONFIRMED

**Evidence.** The stale-read is real and I confirmed the concurrency it depends on. recordIncoming reads `status` at evmListener.ts:181-196, performs the UPDATE at :256-264, and then emits based on the PRE-update value: `if (payment.status === 'waiting') { enqueueWebhook({ paymentId: payment.id, event: 'payment.confirming' }) }` (:273-277). The WS listener registered at :358-377 is an async callback, and ethers v6 does not await it — node_modules/ethers/lib.commonjs/contract/contract.js:486 is a bare `listener.call(contract, ...passArgs)` inside a `sub.listeners.filter(...)`, with only the emit chain itself serialised via `await lastEmit`. So two Transfer logs to one address delivered together each start recordIncoming before the other's UPDATE commits, and both read 'waiting'. The polling reconciler cannot collide with itself (its loop at :487-507 awaits each recordIncoming, and it lags the head by cfg.reorgDepth). The identical pattern is at tronListener.ts:358-362 and bitcoinListener.ts:144-148. Low is right: it needs concurrent transfers to one deposit address, and 'confirming' rarely drives money — but the duplicate is byte-identical and, given the payload has no delivery id (see 'webhook-payload-not-idempotable-or-orderable'), indistinguishable from a retry.

**Fix.** Derive the event from the UPDATE instead of the stale read, using the same guarded pattern already used correctly for the confirmed promotion at :621-628. Change the UPDATE at :256-264 to return the transition: `UPDATE payments SET amount_received = ${RECEIVED_SUM}, tx_hash = $2, status = CASE WHEN status='waiting' THEN 'confirming' ELSE status END WHERE id=$1 AND status IN ('waiting','confirming','partial') RETURNING (SELECT status FROM payments WHERE id=$1) IS DISTINCT FROM status AS transitioned` — or more simply add `AND status = 'waiting'` to a separate guarded UPDATE that returns rows only on the actual transition, and emit only when it returned a row. Apply identically at tronListener.ts:344-362 and bitcoinListener.ts:130-148. This makes emission exactly-once per transition regardless of listener concurrency.

### `processSweep` checks `status = 'confirmed'` with a plain read and discards the result of the later compare-and-set
`backend/src/workers/index.ts:67` — concurrency — status: DOWNGRADED

**Evidence.** The code shape is exactly as described, but the concrete failure needs a reorg deeper than 12 blocks landing inside a ~3-block window, which is not 'a matter of when, not if' on BSC. medium -> low.

Shape, confirmed:
- workers/index.ts:47-62 reads the payment, :67-70 tests `if (payment.status !== 'confirmed') return;`, the irreversible transfer happens at :88-93, and only then :119-122 runs `UPDATE payments SET status='swept' WHERE id=$1 AND status='confirmed'` — with the return value discarded (`await query(...)`, not assigned, no rowcount check).
- evmListener.ts:713-723 can concurrently revert the payment to 'waiting' from a different process.

Why the window is much narrower than claimed. Promotion happens at `head - block_number >= required_confirmations` = 12 (evmListener.ts:615, REQUIRED_CONFIRMATIONS=12 in .env). detectReorgs only considers rows with `block_number > head - reorgDepth` = head - 15 (evmListener.ts:665, 679). So a just-promoted payment is a reorg candidate for exactly 3 more blocks — a couple of seconds on BSC — after which it drops out of the candidate set entirely, while the sweep itself (gas top-up + `wait(1)`, token transfer + `wait(1)`, evmAdapter.ts:375-407) takes tens of seconds. Reverting a payment mid-sweep therefore requires a 12-to-15-block BSC reorg that is detected within that 2-3s slice. The auditor's 'BSC reorgs at depth < 15 are routine' conflates ordinary 1-2 block reorgs with 12-15 block ones; the latter are not routine on BSC.

I also checked the other way the CAS could fail — two sweep workers on the same payment — and it is benign: after a successful sweep the deposit's on-chain balance is zero, so the second run returns null at evmAdapter.ts:338-344 and processSweep returns at :94-97 before touching anything.

What remains genuinely worth fixing is the discarded rowcount: a sweep that moved money but could not record it is precisely the event an operator must see, and today it is silent.

**Fix.** (a) Cheapest and most valuable half — check the CAS. workers/index.ts:119-122:
```ts
const swept = await query<{ id: string }>(
  `UPDATE payments SET status = 'swept' WHERE id = $1 AND status = 'confirmed' RETURNING id`,
  [paymentId],
);
if (swept.length === 0) {
  logger.error(
    { paymentId, txHash, amount: balanceHuman },
    'SWEEP MOVED FUNDS BUT THE PAYMENT WAS NO LONGER `confirmed` — funds are in the central wallet with no settleable payment; manual reconciliation required',
  );
}
```
and alert on that log line.

(b) If you want the race closed rather than merely observed: add `sweeping` to the `payment_status` enum (schema.sql:30) and replace the read-and-test at workers/index.ts:47-70 with a claiming CAS — `UPDATE payments SET status='sweeping' WHERE id=$1 AND status='confirmed' RETURNING ...`, returning early on zero rows. Then add `AND status <> 'sweeping'` to the reorg revert at evmListener.ts:721 and route those payments to a manual-review queue instead, since a swept-but-reorged deposit is not automatically resolvable. Remember to add 'sweeping' to the balance sums at payoutService.ts:471 and the settle tick's selectors, or the payment vanishes from both while in flight.

### `ON CONFLICT (tx_hash, log_index)` cannot fire for sweep and gas-funding rows because `log_index` is NULL
`backend/src/workers/index.ts:101` — concurrency — status: DOWNGRADED

**Evidence.** The SQL claim is exactly right; the exploit path is not, so medium -> low.

SQL, confirmed:
- workers/index.ts:101-116 lists `(payment_id, direction, tx_hash, from_address, to_address, amount, token, asset, network, status)` — no log_index — and ends `ON CONFLICT (tx_hash, log_index) DO NOTHING`. schema.sql:561 is `log_index INT` (nullable, no default) and schema.sql:564 is a bare `UNIQUE (tx_hash, log_index)`. No migration alters it. Under Postgres's default NULLS DISTINCT two rows with the same tx_hash and NULL log_index do not conflict, so the clause is dead.
- evmAdapter.ts:380-395 (gas_funding) has the identical defect.
- The contrast the auditor draws is correct: evmListener.ts:224 supplies a real log index, evmListener.ts:421-429 uses the `-1` native sentinel with the reasoning spelled out at :397-400, tronListener.ts:382/398 uses 0/-1, and bitcoinListener.ts:112-126 uses vout. Idempotency holds on those paths and only those.

Why the consequence does not follow. For a duplicate row to appear, processSweep must reach line 101 TWICE WITH THE SAME tx_hash. After a successful sweep the deposit's token balance is zero, so a re-run exits at evmAdapter.ts:338-344 -> workers/index.ts:94-97, never reaching the INSERT. If more funds did arrive, the second sweep is a different transaction with a different hash — two rows are then CORRECT and would not have conflicted anyway. The only construction I could find is two concurrent executions of the same sweep signing byte-identical transactions from the deposit key at the same nonce, which requires a BullMQ stall AND unchanged gas pricing. So no realistic path produces the double-count.

It is still worth fixing: the clause is a false guarantee that a future change (e.g. recording a partial sweep, or retrying after a DB error with the hash already in hand) would silently rely on, and the header at evmListener.ts:40-41 advertises an idempotency these two inserts do not have.

**Fix.** Give both rows a real, deterministic log_index rather than a clause that cannot fire, mirroring the `-1` convention the native scanner already established.

workers/index.ts:101-116 — add `log_index` to the column list and pass `-2`:
```sql
INSERT INTO blockchain_transactions
  (payment_id, direction, tx_hash, from_address, to_address, amount, token,
   asset, network, status, log_index)
VALUES ($1, 'sweep', $2, $3, $4, $5, $6, $6, $7, 'confirmed', -2)
ON CONFLICT (tx_hash, log_index) DO NOTHING
```

evmAdapter.ts:380-395 — same, with `-3` for gas_funding. Two distinct sentinels rather than one, because a gas top-up and a sweep can in principle share a transaction hash and must not collide.

Do NOT reach for `UNIQUE NULLS NOT DISTINCT` here: it would make the existing clause behave as written but would also silently merge a sweep and a gas top-up that share a hash. Add a CHECK documenting the convention instead:
```sql
COMMENT ON COLUMN blockchain_transactions.log_index IS
  'Real EVM log index for token transfers; sentinels: -1 native transfer, -2 sweep, -3 gas funding. Never NULL — a NULL defeats UNIQUE (tx_hash, log_index).';
ALTER TABLE blockchain_transactions ALTER COLUMN log_index SET NOT NULL;  -- after backfilling existing NULLs
```

### The Idempotency-Key middleware caches only completed responses, so two concurrent requests with the same key both execute
`backend/src/middleware/idempotency.ts:36` — concurrency — status: DOWNGRADED

**Evidence.** The GAP is real; the consequence chain is substantially wrong, so medium -> low.

Gap, confirmed: idempotency.ts:37-43 does a bare `redis.get` then falls through to `next()` at :63, and the cache is written only from the wrapped res.json at :53-61, after the handler has finished. There is no reservation between the read and the write, so a second request presenting the same key mid-flight sees a miss and runs the handler too. The `'NX'` at :57 guards against overwriting, not against concurrent execution. Mounted only on POST /payments (routes/payments.ts:49).

What refutes the impact:
- 'Every subsequent retry with the same key also 409s, and the merchant has no way to recover the payment id.' False. The FIRST request succeeds and its 201 IS cached (it is the only writer at that point, so `NX` succeeds). Only the one genuinely concurrent duplicate gets the 409; the third and later retries replay the cached 201 from :39-42. The failure is a single spurious 409, self-healing on the next attempt.
- 'Burning derivation indexes.' False. The losing request's `UPDATE hd_counter SET next_index = next_index + 1` (hdwallet.ts:51-56) runs inside the transaction opened by withTransaction (pool.ts:56), and the 23505 propagates out so pool.ts:62 ROLLBACKs it. The increment is undone; no index is consumed and no gap appears.
- No duplicate payment is created either way: schema.sql:348 `UNIQUE (client_id, order_id)` holds, and apiError.ts:92-95 maps 23505 to a 409.

So the real residue is a confusing 409 on a request that in fact succeeded, plus the fact that two requests sharing a key but carrying DIFFERENT bodies both execute (an integration bug rather than a gateway one).

**Fix.** Reserve the key before running the handler. In idempotency.ts, replace the read-then-fallthrough at :36-63:
```ts
const claimed = await redis.set(redisKey, JSON.stringify({ state: 'in_flight' }), 'PX', 60_000, 'NX');
if (claimed !== 'OK') {
  const existing = await redis.get(redisKey);
  const parsed = existing ? JSON.parse(existing) as CachedResponse | { state: string } : null;
  if (parsed && 'status' in parsed) {
    res.setHeader('Idempotent-Replay', 'true');
    res.status(parsed.status).json(parsed.body);
  } else {
    res.status(409).json({ error: 'in_progress', message: 'A request with this Idempotency-Key is still being processed. Retry shortly.' });
  }
  return;
}
```
Then drop the `'NX'` at :57 so the res.json wrapper OVERWRITES the in_flight marker with the real response (with `'NX'` it would refuse, and the key would expire in 60s leaving no cached result). Cache 4xx as well as 2xx, so a deterministic rejection replays instead of re-running.

Crucially, also clear the reservation when the handler THROWS — otherwise a 500 leaves the key claimed for 60s and the merchant's legitimate retry gets a 409. Wrap `next()` so the error path deletes redisKey.

Separately, and this is the change that actually makes the merchant's retry idempotent rather than merely deduplicated: in paymentService.ts:230-236, return the existing payment instead of throwing on an orderId collision (`SELECT * ... ; if (dup) return toDTO(dup)`), so a retry that arrives without an Idempotency-Key is safe too.

### `setCommission` can leave two rows with `is_active = true` for one client
`backend/src/services/commissionService.ts:178` — concurrency — status: DOWNGRADED

**Evidence.** The invariant violation is real; the described financial consequence is not. medium -> low.

Confirmed:
- commissionService.ts:186-205 runs `UPDATE commissions SET is_active = false WHERE client_id=$1 AND is_active=true` then an `INSERT ... is_active = true`, inside withTransaction (pool.ts:51-70), which issues a bare BEGIN — nothing in the codebase sets an isolation level, so READ COMMITTED.
- At READ COMMITTED the interleaving works: T2's UPDATE blocks on T1's row lock over the pre-existing active row; when T1 commits, T2's UPDATE re-evaluates and finds is_active already false, and T1's newly INSERTED row is invisible to T2's already-started statement. T2 then inserts its own. Two active rows.
- No constraint stops it. schema.sql:631 is `CREATE INDEX idx_commissions_client_active ON commissions(client_id) WHERE is_active;` — a plain index, not UNIQUE. I grepped all 21 migrations for any UNIQUE on commissions: none.
- commissionService.ts:179-184's existence check is a plain `SELECT 1 FROM clients WHERE id = $1` with no FOR UPDATE, so it does not serialise anything.

What refutes the impact. The auditor says payouts would then split 'at 1% or 1.5% essentially at random depending on nothing observable'. That is wrong: getActiveCommission (commissionService.ts:54-60) is `ORDER BY created_at DESC LIMIT 1` over rows whose created_at is fixed at insert time. Once both rows exist the ordering is deterministic and every subsequent payout uses the SAME rate. There is no per-payout flapping and no drift across thousands of settlements. Because created_at is transaction START time and the blocked transaction started later, the row that wins is normally the one the second admin submitted — i.e. usually the intended one.

The residual defect is a stale extra active row and a narrow window where the effective rate disagrees with the value returned to the admin who submitted last (possible only when the transaction that started EARLIER commits later). Worth fixing as a data-integrity invariant; not a revenue-reconciliation hazard, and not load-related at all.

**Fix.** Make 'at most one active commission per client' a database invariant and let the loser fail loudly:
```sql
-- replaces schema.sql:631
DROP INDEX IF EXISTS idx_commissions_client_active;
CREATE UNIQUE INDEX CONCURRENTLY idx_commissions_one_active
  ON commissions(client_id) WHERE is_active;
```
Run a de-duplication pass first, since existing data may already violate it:
```sql
UPDATE commissions c SET is_active = false
 WHERE c.is_active
   AND c.id <> (SELECT id FROM commissions c2 WHERE c2.client_id = c.client_id AND c2.is_active ORDER BY created_at DESC, id DESC LIMIT 1);
```

Then serialise per client so the losing transaction blocks rather than races — commissionService.ts:179-184:
```ts
const exists = await client.query(`SELECT 1 FROM clients WHERE id = $1 FOR UPDATE`, [input.clientId]);
```
With the row lock held, the UPDATE/INSERT pair is atomic per client and the unique index becomes a backstop rather than the primary mechanism. Should 23505 still surface, apiError.ts:92-95 already maps it to 409; catch it in setCommission and rethrow as `AppError.conflict('This client\'s commission was changed concurrently. Reload and try again.')` so the admin sees something actionable rather than 'Resource already exists'.

Separately, tighten getActiveCommission (commissionService.ts:54-60) to `ORDER BY created_at DESC, id DESC LIMIT 1` — with the unique index in place it can only ever match one row, but the deterministic tiebreak costs nothing and removes the last ambiguity.

### The listeners install `uncaughtException` handlers that log and keep running
`backend/src/blockchain/evmListener.ts:775` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** The handlers exist as described, but the concrete failure scenario offered is not reachable, so this is a hardening concern rather than a critical defect.

TRUE: evmListener.ts:775-777, tronListener.ts:554-556 and bitcoinListener.ts:282-284 each register `process.on('uncaughtException', (err) => logger.error({ err }, 'uncaughtException (… continues)'))`, which suppresses Node's default print-and-exit-non-zero. Node's own documentation is explicit that resuming after an uncaught exception is unsafe.

REFUTED — the stated failure. 'If the throw happened between `running = true` (evmListener.ts:795) and the `.finally()` that clears it, the reconciler is permanently disabled.' That cannot happen. The tick body is:
```
if (running) return;
running = true;
reconcileOnce().catch(...).finally(() => { running = false; });
```
`reconcileOnce` is declared `async` (evmListener.ts:438), so it can only ever return a promise — a throw anywhere inside it becomes a rejection, which `.catch()` at :797 handles and `.finally()` at :798-800 clears. There is no synchronous code between `running = true` and the `.finally()` registration that can throw. The same holds for the native loop (:813-822), tronListener.ts:566-574 and bitcoinListener.ts:294-302. So the 'same terminal state as the Redis-hang finding, reached a different way' does not exist; the Redis hang gets there because the promise never settles, which is a different mechanism entirely.

Also worth noting against the recommendation: the handler is not purely gratuitous. The comment at evmListener.ts:333-335 records a real crash — an unhandled socket `'error'` event from an ethers WebSocketProvider whose `.websocket` was not yet exposed, which is a synchronous EventEmitter throw. The guard at :341 covers the normal case, and the uncaughtException handler is the second net for when it does not. Removing it without keeping that in mind reintroduces a crash the WS path is explicitly best-effort about.

**Fix.** Change the disposition from 'log and continue' to 'log fatally and exit', but do it knowing what it costs. In evmListener.ts:775-777, tronListener.ts:554-556 and bitcoinListener.ts:282-284:
```ts
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — exiting for restart');
  process.exit(1);
});
```
All the state that matters is idempotent and lives in Postgres (UNIQUE (tx_hash, log_index) at schema.sql:565, plus WHERE-guarded status transitions), which is exactly what makes restarting safe. Before making this change, harden the one known source first so it does not become a restart loop: in evmListener.ts:336-349, attach the socket handlers defensively on every reconnect rather than only when `.websocket` is already present — e.g. retry the attach on the next tick if `socket` is undefined, and keep the provider-level `on('error')` net at :346-349. Leave the `unhandledRejection` handler logging-and-exiting too (see the API/worker finding), since every intentional fire-and-forget in this codebase already carries its own `.catch()`.

### `/health` is registered after the global rate limiter, so probes consume limiter budget and 500 during a Redis outage
`backend/src/index.ts:57` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** The ordering defect is exactly as stated. The consequence is not, because nothing in this repo probes /health on a schedule.

TRUE: index.ts:57 `app.use(globalRateLimiter);` with no path, then :60 `app.get('/health', ...)`. Express runs `app.use` middleware for every request, so the health route does pass through the limiter, and the comment at :59 ('no auth, no rate concerns for orchestrators') asserts the opposite. globalRateLimiter is 120/60_000 keyed by IP (rateLimit.ts:28-35, config/env.ts:319-320), and `app.set('trust proxy', 1)` at :29 makes the key the client address behind one proxy hop.

REFUTED — 'the orchestrator restarts healthy containers' and the cascade. There is no orchestrator health probe anywhere in the deployment. docker-compose.yml defines `healthcheck` blocks only on postgres (:12-16) and redis (:24-28); the `api` service (:30-40) has none, so Docker never evaluates HTTP health and `restart: unless-stopped` only reacts to process exit. The production path is pm2 (deploy-crypto-gateway.sh:300-330), which does no HTTP probing at all; the only /health call in the whole repo is a single post-deploy `curl` at :335, from 127.0.0.1. So there is no mechanism by which a 429 on /health restarts anything, and no self-reinforcing outage.

What remains is genuine but small: each probe burns a limiter token and a Redis round trip, and during a Redis outage /health returns 500 along with everything else (see the passOnStoreError finding) — meaning the endpoint reports the API unhealthy for a reason unrelated to whether it can serve requests. That is a latent risk and a missing guard: low.

**Fix.** backend/src/index.ts — move the health registration above the limiter, and split liveness from readiness so the distinction exists before something starts probing it:
```ts
// Liveness — must answer before any middleware that can fail. Deliberately
// registered ahead of globalRateLimiter: a probe that 429s or 500s because of
// a dependency is worse than no probe.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'crypto-gateway', ts: Date.now() });
});

app.use(globalRateLimiter);

// Readiness — may legitimately fail when a dependency is down.
app.get('/ready', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    logger.warn({ err }, 'readiness check failed');
    res.status(503).json({ status: 'not_ready' });
  }
});
```
Then add `healthcheck: { test: ["CMD", "wget", "-qO-", "http://localhost:4000/health"], interval: 10s, timeout: 3s, retries: 3 }` to the `api` service in docker-compose.yml — the point of fixing the ordering is that a probe becomes safe to add.

### No `error` listener on any BullMQ Queue or Worker, so Redis-layer failures print outside the pino pipeline
`backend/src/workers/index.ts:351` — crash / availability / operational resilience — status: DOWNGRADED

**Evidence.** Every factual claim checks out, including the reporter's own correction that this does not crash the process. The impact is purely observability, which the severity ladder puts at low.

workers/index.ts:351-361 attaches `failed` (:352) and `completed` (:358) to every worker in the loop, and no `error`. None of the seven Queue instances in workers/queues.ts (:37, :42, :51, :60, :62, :64, :66) has one either. I confirmed the non-crash in BullMQ 5.79.2: queue-base.js:87-100 wraps `super.emit` in try/catch, re-emits as `'error'`, catches again, and falls through to a bare `console.error(err)`. So an unhandled `error` event on a Queue or Worker becomes unstructured stderr output with no `service` field, no pino level and no redaction, while every other line in the system is parseable JSON (logger.ts:10-38).

The practical consequence is that connection errors, scheduler errors and lock-extension failures are invisible to log aggregation keyed on JSON, so a stalled sweep or payout queue presents as an absence of activity rather than an alert. Real, worth fixing, and cheap — but it degrades nobody's money and takes nothing down, so it is 'poor observability': low.

**Fix.** (1) backend/src/workers/index.ts — add two lines inside the existing loop at :351-361:
```ts
w.on('error', (err) => logger.error({ queue: w.name, err }, 'bullmq worker error'));
w.on('stalled', (jobId) => logger.warn({ queue: w.name, jobId }, 'bullmq job stalled and will be re-run'));
```
The `stalled` listener matters here specifically: it is the signal that fires in the orphaned-sweep scenario, and chainBroadcast.ts's nonce pinning is what makes the re-run safe — so you want to see it, not just survive it.
(2) backend/src/workers/queues.ts — stop constructing Queues bare. Add a helper and route all seven through it:
```ts
function makeQueue(name: string, opts?: Partial<QueueOptions>): Queue {
  const q = new Queue(name, { connection, defaultJobOptions, ...opts });
  q.on('error', (err) => logger.error({ queue: name, err }, 'bullmq queue error'));
  return q;
}
```
Then `export const webhookQueue = makeQueue(QUEUE_NAMES.webhook);`, `export const sweepQueue = makeQueue(QUEUE_NAMES.sweep, { defaultJobOptions: { ...defaultJobOptions, attempts: 5, backoff: { type: 'exponential', delay: 15_000 } } });` and so on for :51, :60, :62, :64, :66. Attaching it once in the factory is what stops the next queue from being added without one.

### Every EVM adapter operation constructs a fresh `JsonRpcProvider` that is never destroyed
`backend/src/blockchain/evmAdapter.ts:57` — crash / availability / operational resilience — status: CONFIRMED

**Evidence.** Confirmed at both ends of the call.

evmAdapter.ts:57 `const provider = (): JsonRpcProvider => httpProviderFor(cfg.httpRpc, cfg.chainId);` and usdt.ts:43-45 `export function httpProviderFor(rpcUrl, chainId) { return new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }); }` — no cache, no memoisation, a genuinely new instance per call. Called fresh at :287 and :288 (balanceOf), :293 (nativeBalanceOf), :318 (sweepDeposit), :417 (sendPayout), :454 (preparePayout), :495 (broadcastPayout) and :519 (waitForTx). None is ever `destroy()`ed.

The contrast the reporter draws is right: the listener builds its providers exactly once, at evmListener.ts:779-780, and holds them in module scope.

The severity assessment is also right and I am not inflating it. `staticNetwork: true` means construction issues no network call and installs no poller, so an idle provider holds no libuv handle and is collectable. The costs are GC churn, a fresh `FetchRequest` per call instead of a shared keep-alive agent, and — the one that actually matters — `waitForTransaction` at :519, which installs a subscriber and starts a poller on a provider nobody will ever destroy.

**Fix.** backend/src/blockchain/evmAdapter.ts — hoist the provider into the factory closure, exactly as the listener does:
```ts
export function createEvmAdapter(cfg: EvmChainConfig): ChainAdapter {
  // One provider per adapter, created once. ethers keeps a keep-alive agent per
  // instance, so a per-call provider means a fresh TCP setup on every sweep and
  // payout against an endpoint that is usually metered.
  const rpc = httpProviderFor(cfg.httpRpc, cfg.chainId);
  const provider = (): JsonRpcProvider => rpc;
```
That one-line change fixes all seven call sites without touching them. Keep the `provider()` accessor rather than inlining `rpc`, so `sweepDeposit`'s local `const rpc = provider();` at :318 and the shadowing at :454 still compile unchanged. If a per-call provider is ever genuinely needed (a distinct endpoint, an isolated nonce view), wrap that one in try/finally with `p.destroy()`.

### Percentage commission reads its scale from BEP20 USDT's env-overridable decimals but hardcodes 10^18 in the divisor
`backend/src/services/commissionService.ts:245` — money — status: DOWNGRADED

**Evidence.** The arithmetic claim is exactly right and I reproduced it. commissionService.ts:24 imports `toBaseUnits`/`fromBaseUnits` from blockchain/usdt.ts rather than the purpose-built helpers in utils/money.ts. Those default to `assetFor('BEP20','USDT')` (usdt.ts:96-98, 117-123), whose decimals is `config.chain.usdtDecimals ?? asset.decimals` (assets.ts:276) i.e. the USDT_DECIMALS env var (config/env.ts:71). applyRate hardcodes the divisor: `return (grossU * valueScaled) / (100n * 10n ** 18n);` (commissionService.ts:245). Ran it with the repo's ethers: at 18 dp a 2% commission on 1000 yields '20.0'; with both sides at 6 dp and the hardcoded 10^18 divisor it yields exactly '0.0'. Confirmed that `fixed` survives a changed scale (toBaseUnits/fromBaseUnits round-trip symmetrically at lines 247, 267-268, 289-291) and only the percentage divisor breaks. utils/money.ts:21-22 states the rule this violates, and payoutService.ts:17 already imports it correctly — commissionService is the one holdout.

DOWNGRADED from medium to low because it is completely inert on every shipped configuration: config/env.ts:71 defaults USDT_DECIMALS to 18, /.env line 27 sets 18, and /.env.example line 37 sets 18. Nothing today triggers it. It is a latent config landmine — silent and total when it fires, which is why it is worth fixing — but calling it medium overstates a defect that cannot currently occur.

**Fix.** Sever the coupling: commissionService is ledger arithmetic, not chain arithmetic.
(1) backend/src/services/commissionService.ts:24 — replace with `import { toAccountingUnits, fromAccountingUnits, ACCOUNTING_DECIMALS } from '../utils/money';`
(2) Substitute those helpers at lines 131-132 (pickTier bounds), 244 and 247 (applyRate), 267-268 (computeSplit inputs) and 289-291 (outputs).
(3) Line 245 — take the scale from the same constant so the two cannot drift: `return (grossU * valueScaled) / (100n * 10n ** BigInt(ACCOUNTING_DECIMALS));`
(4) Add a boot assertion in `validateAssetList` (blockchain/assets.ts:485) that no enabled asset's decimals exceed ACCOUNTING_DECIMALS, referencing the constant rather than the `<= 18` literal at line 494.
Note this is the same architectural split as `no-decimal-validation-against-asset` but a different trigger — that one is live today, this one is not; fix both, but ship that one first.

### Each payout request holds a pool connection through an advisory lock plus three sequential aggregates, one of which is unused
`backend/src/services/payoutService.ts:468` — money — status: DOWNGRADED

**Evidence.** The concrete parts are confirmed. requestPayout opens a transaction (payoutService.ts:149), takes `pg_advisory_xact_lock` keyed on `(clientId, network)` (169-172), then calls getBalanceWith on that same connection, which issues three sequentially awaited aggregates — confirmed (468-472), pending (473-477), paidOut (481-485) — followed by the INSERT (189-208) and an audit write (211-228). The pool is `new Pool({ max: 20, connectionTimeoutMillis: 10_000 })` with `max` hardcoded and not env-configurable (db/pool.ts:14-19). And the `pending` aggregate really is dead weight inside the lock: the guard at line 182 reads only `balance.available`, which is derived from `confirmed` and `paidOut` alone (487-489). getAllBalances (375-426) already demonstrates the single-pass CTE form.

DOWNGRADED from medium to low because the headline causal claim is not demonstrated. The three aggregates are fully index-covered — `idx_payments_client_network_asset_status` (sql/schema.sql:366) and `idx_payouts_client_network_asset_status` (664-665) both match the (client_id, network, asset, status) predicate exactly — so each is a sub-millisecond index scan. At that latency 20 connections serve thousands of requests per second and 1,000 concurrent requests do not exhaust the pool by themselves. The pool DOES become a real problem, but via the unbounded whole-history aggregates in the admin dashboard and client list, and via the settle tick's unbounded payout loop — which are reported separately as `admin-dashboard-revenue-cross-asset-float`, `admin-balances-cross-asset-float` and `settle-tick-unbounded-and-starved`. Attributing pool exhaustion to the payout guard misdirects the fix.

**Fix.** (1) backend/src/services/payoutService.ts:463-485 — collapse the three aggregates into ONE statement using FILTER clauses over a single scan, the pattern routes/account.ts:774-807 already uses correctly:
  SELECT COALESCE(SUM(amount_received) FILTER (WHERE status IN ('confirmed','swept')),0)::text AS confirmed,
         COALESCE(SUM(amount)          FILTER (WHERE status IN ('waiting','confirming','partial')),0)::text AS pending
    FROM payments WHERE client_id = $1 ...
plus one payouts query. Cuts in-lock round trips from three to two.
(2) Split the function: give requestPayout a `getSettleableBalance` that computes only confirmed and paidOut (one query, no `pending`), and leave the three-value form for display callers outside the lock. Cuts it to one.
(3) backend/src/db/pool.ts:16 — make `max` configurable from env (`PG_POOL_MAX`, default 20). The deployment runs horizontally-scaled API and worker processes against one Postgres, so the correct value is `max_connections / process_count`, which cannot be a source-code constant. Add PgBouncer in transaction-pooling mode; note `pg_advisory_xact_lock` is transaction-scoped (payoutService.ts:158-161 relies on this) so it is compatible, whereas a session-scoped lock would not be.
(4) Note the lock key uses `hashtext($2)` (line 169), a 32-bit hash — distinct (client, network) pairs will collide at scale and over-serialise unrelated merchants. Harmless for correctness, worth a comment.

### `GET /payouts` returns every payout a merchant has ever had, with no LIMIT and no pagination
`backend/src/routes/payouts.ts:76` — money — status: CONFIRMED

**Evidence.** Confirmed verbatim: routes/payouts.ts:76-81 is `SELECT id, gross_amount, status, to_address, network, asset, tx_hash, created_at FROM payouts WHERE client_id = $1 ORDER BY created_at DESC` with no LIMIT, no OFFSET, no date filter and no status filter, behind clientAuth + paymentsRead scope (lines 61-63). Every sibling list is bounded — listPayments clamps to `Math.min(100, ...)` with pagination (paymentService.ts:349-376), listWithdrawals takes a limit defaulting to 50 (adminCommissionService.ts:305-310), listLinks caps at 200 (paymentLinkService.ts:255-257), listUnexpectedDeposits caps at 200 (unexpectedDepositService.ts:186-192). `idx_payouts_client` (sql/schema.sql:663) makes the lookup cheap, which is exactly what hides the cost — it is in materialising and serialising the full result set into the Node heap. With auto-payout on, payouts grow roughly one row per payment, so a busy merchant reaches millions of rows within a year and one request can OOM an API instance. Correctly low today: it needs volume to accumulate first, and it is availability rather than money.

**Fix.** backend/src/routes/payouts.ts:60-84 — add pagination with the same clamping listPayments uses (paymentService.ts:349-351):
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const page  = Math.max(1, Number(req.query.page) || 1);
append `LIMIT $2 OFFSET $3`, add an optional `status` filter, and return `{ data, page, limit, total }` to match the payments list shape (run a `SELECT COUNT(*)` alongside). Update client-panel/src/lib/api.ts and the Payouts page to page through.
Then audit the remaining merchant-scoped lists on per-payment-growth tables for the same omission — the 200-row caps on listLinks and listUnexpectedDeposits are bounds but not pagination, so a merchant simply cannot see older rows; both deserve real paging.

### Reorg detection makes one sequential eth_getTransactionReceipt RPC call per candidate row, every 5 seconds
`backend/src/blockchain/evmListener.ts:664` — scale-and-load — status: DOWNGRADED

**Evidence.** The code shape is exactly as described: evmListener.ts:666-681 selects every incoming row with `block_number > $1` where $1 = head - cfg.reorgDepth, including status='confirmed' as well as 'pending', and :683-690 loops `for (const c of candidates) { receipt = await httpRpc.getTransactionReceipt(c.tx_hash) }` serially with no batching and no short-circuit. It runs from reconcileOnce at :452 every 5 s.

DOWNGRADED because the candidate set is bounded by reorg-window arrival rate, not by table size, and the finding's arithmetic assumes a block time that is not BSC's. REORG_DEPTH defaults to 15 (config/env.ts:330) and the file's own comment at evmListener.ts:117 puts BSC at ~0.45 s blocks, so the window is ~7 seconds of chain history, not the 45 s the finding assumes from 3 s blocks. To exceed the 5 s pass budget at 150 ms per receipt you would need >33 deposits landing inside that window — roughly 3 deposits/second, i.e. ~260k payments/day, which is far above 100k coins/day at any plausible payment size. Ethereum is the closer case (ETH_REORG_DEPTH 12 at ~12 s blocks = a 144 s window, so ~33 deposits in 144 s ≈ 20k ETH-chain deposits/day) but still above the stated load. Real N+1, genuinely worth fixing, but it does not bind at the load in question.

**Fix.** Two cheap changes in evmListener.ts:683-690. (1) Batch: replace the serial for-loop with chunked parallelism — `for (let i = 0; i < candidates.length; i += 20) { const chunk = candidates.slice(i, i + 20); const receipts = await Promise.all(chunk.map(c => httpRpc.getTransactionReceipt(c.tx_hash).catch(() => undefined))); ... }`. ethers v6 coalesces concurrent calls on one provider into a single JSON-RPC batch by default, which is exactly why usdt.ts:70-76 has to opt out with `batchMaxCount: 1` for the native scanner — so this collapses 20 round trips into one. (2) Skip rows that cannot reorg by adding `AND confirmations < $2` to the candidate query at :673-681 with $2 = required_confirmations + cfg.reorgDepth. Structural improvement for later: add a `block_hash TEXT` column to blockchain_transactions, populate it in recordIncoming, and detect reorgs by comparing cfg.reorgDepth `eth_getBlockByNumber` hashes per pass — O(reorgDepth) calls instead of O(transactions).

### The EVM adapter constructs a fresh JsonRpcProvider on every single call, defeating ethers' request batching
`backend/src/blockchain/evmAdapter.ts:57` — scale-and-load — status: DOWNGRADED

**Evidence.** The code fact is exactly right. evmAdapter.ts:57 `const provider = (): JsonRpcProvider => httpProviderFor(cfg.httpRpc, cfg.chainId);` and usdt.ts:42-44 confirms httpProviderFor does `return new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true })` with no caching. It is invoked fresh at evmAdapter.ts:287, :288, :293, :318, :417, :454, :495 and :519, and none is ever destroy()ed. The listener does it correctly by contrast, building once at evmListener.ts:779-780.

DOWNGRADED because the stated impact does not follow. (a) The RPC call COUNT is unchanged by sharing a provider — ethers batches only calls issued in the same event-loop tick, and every adapter call site is a sequential await (balanceOf, then getBalance, then the top-up, then the transfer), so nothing would coalesce even with one shared instance. The only genuine win is across concurrent jobs, and sweep/payout concurrency is 3 each (workers/index.ts:306, :312). So 'multiplies cost on a metered endpoint' and 'multiplies the chance of the listener being rate-limited' are not supported. (b) `staticNetwork: true` means no extra eth_chainId round trip per construction, so there is no hidden per-call RPC tax. (c) The leak claim is speculative: ethers v6 JsonRpcProvider only runs its poller while a subscriber exists, and waitForTransaction removes its subscriber on settle or timeout. Real defect (object churn, no connection/batch reuse, no destroy on shutdown, single RPC with no failover), but low.

**Fix.** In createEvmAdapter, replace the factory at evmAdapter.ts:57 with a single instance — `const rpc = httpProviderFor(cfg.httpRpc, cfg.chainId);` — and substitute `rpc` at all eight call sites (:287, :288, :293, :318, :417, :454, :495, :519), deleting the local `const rpc = provider()` shadows at :318 and :454. Keep it distinct from the listener's provider so settlement and detection do not share a batch window (they are separate processes today, so this is automatic). Add `destroy()` to the adapter interface and call it from the SIGTERM handlers in workers/index.ts:372 and index.ts:127. While here, make cfg.httpRpc accept a comma-separated list and wrap it in ethers' FallbackProvider — a single RPC URL is a hard single point of failure for both sweeps and payouts.

### All outbound transfers on a chain serialise behind one Redis lock with a 45s acquire timeout, and waiters busy-poll
`backend/src/utils/chainLock.ts:100` — scale-and-load — status: DOWNGRADED

**Evidence.** Code facts all check out. chainLock.ts:93-117: `while (Date.now() < deadline) { const res = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX'); if (res === 'OK') break; await sleep(RETRY_DELAY_MS); }` with RETRY_DELAY_MS = 100 (:52) and ACQUIRE_TIMEOUT_MS = 45_000 (:50), on the shared app connection (db/redis.ts:13). It is fleet-wide per (network, role) via chainLockKey at :82-84. Callers confirmed: chainBroadcast.ts:92 and :100 for every payout and admin withdrawal, evmAdapter.ts:375 and tronAdapter.ts:286 for sweep gas top-ups. And chainBroadcast.ts:133-145 does hold `preparePayout` (an eth_getTransactionCount round trip plus signing) and `broadcastPayout` inside the lock.

DOWNGRADED for two reasons. (1) The ceiling does not bind at the stated load. 1/(hold time) with 200-400 ms round trips is 1.5-3 payouts/second fleet-wide; 100k coins/day produces payouts on the order of 0.02-1 per second, i.e. two orders of magnitude of headroom. It degrades only during an RPC incident with an existing backlog. (2) The stalled-job sub-claim is refuted: BullMQ automatically renews a running job's lock on a `lockRenewTime` timer of lockDuration/2 (node_modules/bullmq/dist/cjs/classes/worker.js:34 and :64), so a job waiting 45 s inside its processor is not declared stalled and the advice to make ACQUIRE_TIMEOUT_MS shorter than lockDuration is unnecessary. The spin cost is also negligible — at most ~9 contending jobs x 10 commands/second.

**Fix.** Worth doing, not urgent. (1) Shrink the critical section: payouts already pin and persist nonce/signed_tx before broadcast (payoutService.ts:283-290, sql/schema.sql:657-661), so re-broadcasting identical bytes is a no-op and the broadcast at chainBroadcast.ts:144 does not need serialising. Move `adapter.broadcastPayout(prepared.signedTx)` outside the withChainLock closure, keeping only preparePayout + persistPrepared inside. (2) Remove the RPC round trip from the lock entirely with a nonce allocator: `const nonce = Number(await redis.incr('nonce:'+network+':central')) - 1`, seeded once at boot from eth_getTransactionCount(address,'pending'), passed as `state.nonce` at chainBroadcast.ts:136. Hold time then drops to sub-millisecond. (3) Replace the 100 ms `SET NX` spin at chainLock.ts:103-109 with a Redis-list semaphore (`LPUSH` one token at init; `BLPOP key <timeout>` to acquire, `LPUSH` to release) so waiters block instead of polling and acquisition is FIFO rather than random.

### The API process has no unhandledRejection or uncaughtException handler, unlike every listener process
`backend/src/index.ts:74` — scale-and-load — status: DOWNGRADED

**Evidence.** The asymmetry is real and verified: evmListener.ts:772-777, tronListener.ts:551-556 and bitcoinListener.ts:279-284 each install both handlers with an explicit comment about surviving transient faults; a grep of process.on across index.ts and workers/index.ts returns only SIGTERM/SIGINT (index.ts:136-137, workers/index.ts:377-378). The missing socket timeouts are also verified — I grepped for keepAliveTimeout, headersTimeout and requestTimeout across backend/src and got zero hits, so the server at index.ts:99 uses Node's defaults and slow or half-open clients hold sockets.

DOWNGRADED because the finding's only concrete crash mechanism is refuted. `apiKeyRateLimiter(req, res, next)` at auth.ts:157 cannot produce an unhandled rejection: express-rate-limit wraps its middleware in `handleAsyncErrors` (node_modules/express-rate-limit/dist/index.cjs:689-695), which is `async (req,res,next) => { try { await Promise.resolve(fn(...)).catch(next) } catch (e) { next(e) } }` — the returned promise always resolves and every error is routed to next(). I then audited the other fire-and-forget chains in the request path (auth.ts:149, paymentService.ts:295, evmListener.ts:274, workers/index.ts:176, index.ts:89 -> rateService.ts:452-471 which try/catches internally) and every one carries a .catch. The one genuine unguarded rejection I found is `void main()` at workers/index.ts:381, whose `await scheduleExpiryJob()` at :367 is not in a try/catch — a Redis outage at worker boot crashes the process, which is arguably correct behaviour. So: real missing guard and real missing socket timeouts, but no demonstrated crash path. Low.

**Fix.** In index.ts, after `const server = app.listen(...)` at :99-110 add `server.keepAliveTimeout = 65_000; server.headersTimeout = 66_000; server.requestTimeout = 30_000;` (headersTimeout must exceed keepAliveTimeout, and keepAliveTimeout must exceed the load balancer's idle timeout — 60 s on an AWS ALB — so the server never closes a connection the LB still considers live). Add `process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'))` — log and continue is correct here. For uncaughtException, do NOT log-and-continue in the API: `process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaughtException — draining'); server.close(() => process.exit(1)); setTimeout(() => process.exit(1), 10_000).unref(); })` so in-flight requests drain and the supervisor restarts a clean process. Add both to workers/index.ts as well, and wrap the three schedule calls at :367-369 in a try/catch that logs and exits non-zero.

### Importing workers/queues.ts opens seven Redis connections in every process that touches it, including each listener
`backend/src/workers/queues.ts:37` — scale-and-load — status: CONFIRMED

**Evidence.** queues.ts instantiates seven Queue objects at module scope — lines 37, 42, 51, 60, 62, 64 and 66 — each passed `bullConnectionOptions` (an options object, not an ioredis instance; db/redis.ts:39-50). I read the installed BullMQ 5.79.2 source to check whether that is lazy: node_modules/bullmq/dist/cjs/classes/redis-connection.js:87-88 ends the constructor with `this.initializing = this.init(); this.initializing.catch(...)`, and init() at :176-186 does `new ioredis(rest)` immediately when `_client` is unset. Since opts is not a Redis instance, `shared` is false and each Queue gets its own connection. So the fan-out is eager, exactly as claimed. Import chains confirmed: webhookService.ts:20 imports webhookQueue, all three listeners import sweepQueue (evmListener.ts:55, tronListener.ts:35, bitcoinListener.ts:35), and the API imports scheduleExpiryJob (index.ts:19) — any of those executes the whole module and opens all seven, plus the shared app client at db/redis.ts:13. So an API instance holds ~8 Redis connections while consuming from no queue at all, and each listener the same.

**Fix.** Make producers lazy. Replace each `export const xQueue = new Queue(...)` in queues.ts with a memoised getter — `let _webhookQueue: Queue | null = null; export function webhookQueue(): Queue { return (_webhookQueue ??= new Queue(QUEUE_NAMES.webhook, { connection, defaultJobOptions })); }` — and update the call sites (webhookService.ts:161, evmListener.ts:648, tronListener.ts:465, bitcoinListener.ts:216, payoutService.ts:232, workers/index.ts). An API instance then opens one connection for the expiry queue instead of seven, and a listener one for the sweep queue. Split scheduleExpiryJob/scheduleSettleJob/scheduleSubscriptionJob into a separate module so importing a producer never drags in the schedulers. Log the process's actual Redis connection count at boot and alert at 70% of the provider's client cap — a rolling deploy doubles it while old and new pods overlap.
