# Session handoff — where the work stands

Last updated: 2026-08-08. Read this first if you are picking the project up in a
new session.

**Branch: `feat/multi-asset`** (off `feat/merchant-self-registration`, off
`main`). Neither intermediate branch is merged.

The gateway now settles on four chains: **BEP20** (BSC), **ERC20** (Ethereum),
**TRC20** (Tron) and **Bitcoin**. Only BEP20 is on by default; each of the others
is a deliberate opt-in, because each one can strand funds if half-configured.

---

## Start the stack

```bash
./scripts/dev-up.sh
```

Starts Docker (Postgres + Redis), applies **every** migration in order, and boots
the API, the **BullMQ worker** and both panels in development mode.

The worker owns the repeatable ticks — expiry, settle (which also marks invoices
paid) and subscription billing. It was not started here before R4; without it a
subscription never bills and a paid invoice never leaves `open`, both of which
look like application bugs and are not.

| | URL |
|---|---|
| Merchant panel + public site | http://localhost:5174 |
| Admin panel | http://localhost:5173 |
| API | http://localhost:4000/api/v1 |
| API docs (swagger) | http://localhost:4000/docs |

Stop with `./scripts/dev-up.sh --down`. Logs are in
`$TMPDIR/crypto-gateway-dev/{api,worker,client,admin}.log`.

**Emails are not sent in development** — they are written to the API log. Get the
newest verification or reset link with:

```bash
grep -oE 'http://localhost:5174/(verify-email|reset-password)\?token=[a-f0-9]+' "$TMPDIR/crypto-gateway-dev/api.log" | tail -1
```

Existing accounts: `admin@example.com` (admin panel), `mohit240172@gmail.com`
and `test@gmail.com` (merchant panel).

---

## Done, and verified against a live API + Postgres

| Release | What landed |
|---|---|
| **Self-registration** | Public site, signup → email verification → auto-approve, password reset, multi-key API keys with a second bearer-token mode, IP allowlist enforcement, admin visibility |
| **R1 multi-asset** | An asset is `(network, symbol)`. USDT/USDC/BUSD/DAI on BEP20, USDT/USDC/USDD wired for TRC20. Per-asset balances, sweeps, payouts, listeners |
| **R2 hosted checkout** | `payment_links`, public `/pay/:token` checkout (no auth, mobile-first, live status), merchant links page, design-system pass, bento dashboard |
| **R3 wrong-coin recovery** | `unexpected_deposits`. Detection in both listeners, merchant page, sweep-to-central recovery |
| **R4 fiat, invoices, recurring** | CoinGecko rates cached with stale-while-revalidate, fiat-priced payments and links, invoices with line items + email, subscriptions on a BullMQ tick |
| **R5 native coins** | BNB/TRX as payable assets — block-scan and TronGrid detection, a sweep that pays its own fee, native recovery. **Detection verified live; the sweep/payout broadcast is not — see below** |
| **R6b Bitcoin** | A from-scratch UTXO adapter — BIP-84/bech32, keyless Esplora, fees by transaction size, a sweep that empties an address. **Detection and fee arithmetic verified live; the sweep/payout broadcast is not — but testnet is keyless, so it CAN be** |
| **R6a ERC20** | Ethereum as a settlement network. The EVM layer is now parameterised per chain (`evmChains.ts` + `evmAdapter.ts` + `evmListener.ts`), so BSC and Ethereum run one implementation. **Detection verified live against mainnet; the sweep/payout broadcast is not** |

Migrations: `007` self-registration, `008` multi-asset, `009` payment links,
`010` unexpected deposits, `011` fiat + invoices + subscriptions, `012` native
coins (data only — the ledger already modelled them), `013` ERC20/Ethereum,
`014` Bitcoin.

**`006` is free for good.** It was held open for the unmerged
`feat/erc20-multi-network` branch to renumber its colliding `005` into. That
branch is superseded and must not be merged (see below), so nothing is waiting
for it.

`sql/schema.sql` is the fully-migrated shape and is verified byte-identical to
schema.sql + every migration in order (see the check in its own header). Column
ORDER matters to that diff — a migration's `ADD COLUMN` appends, so anything a
migration introduced belongs at the END of its table there.

---

## Not done — and these are decisions, not oversights

- **R3 conversion (the actual swap).** Schema and merchant preferences exist
  (`clients.auto_convert_unexpected` defaults FALSE, `max_slippage_bps`), but no
  swap executes. Design is settled: a DEX router (PancakeSwap / SunSwap) for
  same-chain because it is atomic and non-custodial; exchange services
  (ChangeNOW / SimpleSwap / StealthEX) take custody *in transit* and freeze on
  undisclosed compliance thresholds, so cross-chain must be opt-in and capped.
  Not shipped because a swap is a money path that cannot be verified without
  funds on a live chain.
- **R5 native BNB + TRX — BUILT, and partly UNVERIFIED.** Detection, the asset
  registry, the fee arithmetic, the panel and the recovery tool are all done and
  tested (see below). What is **not** proven is the part that moves money: the
  native sweep and the native payout have never been broadcast, because that
  needs funded keys on a live chain. They are written, reviewed and gated behind
  `ACCEPT_NATIVE_COINS=false`.

  **Before enabling this in production, test on a testnet with real funds** —
  BSC testnet and Nile both have free faucets. Specifically unproven:
  `sweepNativeDeposit` in `bscAdapter.ts`, `sweepNativeTrx` in `tronAdapter.ts`,
  and the native branches of `sendPayout`/`preparePayout`. What to watch for is
  the fee arithmetic: the sweep sends `balance − fee`, so an off-by-one there
  either strands the remainder or produces a transaction that cannot pay for
  itself.

  Known gap, by design: the BEP20 listener scans full blocks and therefore
  **cannot see BNB moved by a contract** (an internal transfer). Public BSC RPCs
  expose no trace API. Such a deposit is invisible but not lost —
  `tsx src/recover.ts --native <index> <dest>` sweeps it by HD index. Tron has no
  equivalent gap: TronGrid indexes internal transfers and the listener reads
  them.
- ~~R6 Bitcoin~~ — DONE, see the table above. (Kept here only so the note below
  about the superseded branch stays findable.)

  Previously read: Not started, and **NOT blocked** — the note that it "needs a
  node or a provider" is out of date. Blockstream Esplora and mempool.space are
  keyless and serve everything needed (tip height, address stats with
  `chain_stats`, fee estimates), and **testnet is keyless too**, so unlike every
  other chain here the sweep can actually be proven end to end with faucet
  funds.

  It is still a new `ChainAdapter` from scratch: UTXO rather than accounts,
  BIP-84 derivation, bech32 addresses, a new dependency (`bitcoinjs-lib`) to
  sign raw transactions, and a fee computed from transaction SIZE rather than
  gas. `ChainAdapter` assumes an account model in places; expect that to need
  widening, not just a new implementation.

- **DO NOT MERGE `feat/erc20-multi-network`.** It is superseded. That branch
  forked at `77f5393`, before multi-asset, and its `evmListener.ts` has **zero**
  references to assets or natives — merging it would drop the per-asset match
  clause (rule 3 below) and delete the native scanner. Its two good ideas (a
  per-chain EVM config, and a gas policy that DEFERS rather than fails) were
  reimplemented on top of the current code in R6. The branch can be deleted.
  **`006` is therefore free for good** — nothing is waiting to renumber into it.

---

## Rules that are load-bearing — do not "optimise" these

1. **The payout advisory lock stays keyed on `(client, network)`**, namespace
   8123, even though the balance it guards is now per-asset. It is deliberately
   coarser, which over-serialises and is *strictly safe*. Narrowing it to
   include the asset is what could reintroduce the overdraw it exists to
   prevent. See the note in `backend/src/services/payoutService.ts`.
2. **Contract addresses and decimals live in `backend/src/blockchain/assets.ts`,
   never in env or the `assets` table.** A wrong contract credits payments
   against a token nobody sent; wrong decimals mis-scale by orders of magnitude.
   The table carries only enable/display state.
3. **Both listeners must match a deposit on asset AS WELL AS address.** Without
   that clause a USDC transfer to a USDT payment's address is credited 1:1 as
   USDT into a withdrawable balance.
4. **Nothing sums across assets or networks.** Funds are not fungible. The
   dashboard's cross-asset figures are labelled "≈ USD" precisely because they
   are not a balance.
5. **The public checkout surface never widens.** `PublicLink` and
   `getPublicPayment` in `backend/src/services/paymentLinkService.ts` define
   exactly what leaves the building. Adding a field there publishes it to
   everyone ever sent a link URL.
6. **Money-moving endpoints require a dashboard session, never an API key** —
   payout wallet, API keys, password, deposit recovery. See
   `requireDashboardSession` in `backend/src/middleware/clientAuth.ts`.
   Invoices and subscriptions are money-IN, so API keys may use them.
7. **A fiat rate is frozen at payment creation and never recomputed.** The
   `payments.fiat_*` columns are an audit record of a decision, not a cache —
   nothing may UPDATE them. Re-deriving the amount later means a payment could
   fail to confirm for a customer who paid exactly what the page told them to.
8. **A fiat-priced payment LINK stores the fiat amount, not a crypto one**, so an
   invoice sitting unpaid in an inbox for three days is settled at the price
   current when it is paid. `payment_links.amount` and `fiat_amount` are mutually
   exclusive (DB CHECK).
9. **`uq_invoices_subscription_cycle` is what prevents double-billing**, not the
   worker's care. The subscription tick is repeatable and WILL fire twice; the
   unique violation is caught inside a `SAVEPOINT` — without the savepoint the
   failed insert poisons the transaction, the schedule never advances, and the
   tick retries the same collision forever. That bug was real; see the comment
   in `billOne`.
10. **`subscriptions.next_run_at` advances by one interval from its own value**,
    never from `now()`, or a worker outage permanently shifts every future
    billing date. A plan too far behind parks in `needs_attention` rather than
    emptying a backlog of invoices into a customer's inbox.
11. **A rate outage must never fail a crypto-priced payment.** Those never touch
    `rateService` at all. Fiat pricing degrades to a stale rate and only refuses
    (503) past `RATE_MAX_STALE_SECONDS`.
12. **A native sweep must NEVER be gas-funded, and must never send the full
    balance.** It sends `balance − fee` with `gasLimit` and `gasPrice` both
    pinned, so the cost is exact rather than estimated. Estimating the fee after
    choosing the amount is the bug to avoid: a gas-price tick between the two
    reads makes the transaction unaffordable and it fails forever. On Tron the
    reserve is *measured* from the account's free bandwidth — a flat reserve
    strands TRX at every deposit address permanently.
13. **Natives use `log_index = -1`** in `blockchain_transactions`. Real log
    indexes are non-negative, so this cannot collide with a token transfer in
    the same transaction — which happens, since a contract call can both move
    the native coin and emit a `Transfer`.
14. **Native block scanning uses its own non-batching provider**
    (`nativeScanProvider`). ethers batches concurrent calls by default, and a
    public BSC node rejects the resulting batch — taking the token scan's
    `eth_getLogs` down with it, because the transport was shared. Separate
    cursors are not enough if the connection is shared.
15. **Ethereum USDT and USDC are 6 dp; the BSC versions are 18.** DAI is 18 on
    both. This is why decimals live per-ASSET and why `EvmChainConfig` carries
    no `usdtDecimals`. A shared constant would read a 93.53 USDT deposit as
    0.00000000009353 and the payment would never confirm — verified against a
    real mainnet log during R6.
16. **BEP20 and ERC20 derive the SAME address** (both BIP-44 coin type 60).
    Deposit indexes are never reused so no two payments collide, but a customer
    CAN pay on the wrong EVM chain. Those funds are recoverable at the same
    index with `recover.ts --network=ERC20`. TRC20 is genuinely different (coin
    type 195).
17. **An Ethereum sweep DEFERS when gas is too expensive; it does not fail.**
    `requiredGasTopup` returns null and the settle tick retries. Turning that
    into a throw would burn retry attempts and eventually dead-letter a payment
    whose funds are perfectly safe.
18. **One EVM chain per process.** `evmListener.ts` holds the chain in module
    state; `runEvmListener` throws on a second call. Run `start:listener` and
    `start:listener:eth` separately so an RPC outage on one cannot stall the
    other.
19. **Bitcoin has no nonce, so NEVER re-sign a payout — re-broadcast the stored
    bytes.** Identical bytes have an identical txid and the network deduplicates
    them. Re-signing after the first transaction confirmed would select
    different UTXOs and pay twice; `chainBroadcast` refuses to re-sign once a
    broadcast is recorded.
20. **Every Bitcoin sweep pays its own fee out of what it moves.** There is no
    gas station and cannot be one — nothing exists to fund an address with. The
    fee is `vsize x sat/vB`, so consolidating many tiny UTXOs genuinely costs
    more than sweeping one large one, and the estimate must never come in UNDER
    the real size (verified: it is exact or 1-3 vB over).
21. **`estimateVsize` rounds up on purpose.** An underestimate produces a
    transaction below the relay minimum that no node accepts — a silent stall,
    not a loud failure.
22. **BTC is exempt from `ACCEPT_NATIVE_COINS`.** That flag exists because
    accepting a chain's GAS currency inverts the sweep's fee flow. Bitcoin has
    no gas currency to invert against and BTC is its only asset, so gating it
    would mean `BTC_ENABLED=true` did nothing on its own.
23. Every invariant in `docs/security-checklist.md` §1b–1d and the payout
    concurrency notes still applies.

---

## Testing gotchas that cost real time

- **Redis:** `.env` points at `localhost:6379`, where a **host-native**
  redis-server wins over the container. `docker compose exec redis redis-cli
  FLUSHALL` flushes the *wrong* instance. Use `redis-cli -h ::1 -p 6379
  FLUSHALL` to clear rate-limit buckets.
- **Postgres:** container is on **55432** (not 5432). Credentials
  `gateway/gateway`, database `gateway`. Test migrations on a scratch database,
  not the dev one.
- **Concurrency tests:** warm the pg pool first (6 parallel
  `SELECT pg_sleep(0.15)`). Without warming, buggy and correct code both appear
  to pass the overdraw test.
- **`NODE_ENV`:** the repo `.env` says `production`, where the app refuses to
  boot with signup enabled and no SMTP. `dev-up.sh` forces development.
- **Dates from Postgres:** node-postgres parses a `DATE` column into a JS `Date`
  at LOCAL midnight. `new Date(v).toISOString().slice(0,10)` therefore moves it
  back a day for any timezone east of UTC — an invoice saved as due on the 22nd
  came back as the 21st on a machine in IST. Use `toDateOnly` in
  `invoiceService.ts`; a due date is a calendar day and must never round-trip
  through an instant.
- **Exchange rates in tests:** the rate cache lives at the Redis key
  `rate:v1:snapshot`. To exercise the hard-refusal path, delete that key AND
  point `RATE_PROVIDER_URL` somewhere unreachable — deleting it alone just
  triggers a real fetch. Remember the host-native Redis caveat above.
- **JWTs expire in 15 minutes.** A long API test session needs a re-login, not a
  debugging detour.
- **Testing native detection needs no funds.** Point a payment's
  `deposit_address` at a real mainnet address that receives BNB (scan a few
  blocks for a frequent `to`), set `asset='BNB'`, and pin
  `required_confirmations` to something absurd like `999999999`. The listener
  then detects live transfers and moves the payment to `confirming`, but can
  never promote it to `confirmed` — so no sweep is ever enqueued against an
  address you do not control. Delete the rows afterwards.
- **The public BSC RPC rate-limits batches.** `eth_getLogs in batch triggered
  rate limit` is the shared-transport problem described in rule 14, not a bug in
  the scan range.

---

## Config the user still has to supply

- **TRC20** — off. Needs a funded Tron hot wallet in
  `TRON_CENTRAL_WALLET_PRIVATE_KEY`, then `TRON_ENABLED=true`. A transfer from
  an unstaked address burns ~13–30 TRX. See `docs/deployment.md` § Turning
  TRC20 on. Test on Nile first (free faucet).
- **SMTP** — unset. Required in production when signup is enabled, and the only
  way invoice emails actually leave the building. Without it they are rendered
  to the API/worker log and `POST /invoices/:id/send` returns `sent: false`.
- **Exchange rates** — working out of the box on CoinGecko's free tier with no
  key. `COINGECKO_API_KEY` is optional and only raises the upstream limit.
- **Ethereum RPC** — `ETH_ENABLED=true` plus `ETH_HTTP_RPC`. Not strictly a paid
  key: `https://eth.drpc.org` serves every query this gateway makes on its free
  tier (verified — a `to`-filtered `eth_getLogs` over 2,000 blocks). Alchemy or
  Infura is still the right answer for production, because a settlement path
  should not depend on a free public endpoint. Also needs
  `ETH_CENTRAL_WALLET_PRIVATE_KEY` before it will boot.
- **Bitcoin** — nothing to buy, just `BTC_ENABLED=true`. Blockstream and
  mempool.space are keyless on mainnet and testnet.

  **To prove the sweep** (the one money path in this repo that CAN be proven for
  free): set `BTC_NETWORK=testnet`, start the listener, create a BTC payment,
  send the deposit address coins from a testnet faucet, and watch it confirm and
  sweep. That closes the gap left open by R5 and R6a, whose broadcast paths need
  funded mainnet keys.
