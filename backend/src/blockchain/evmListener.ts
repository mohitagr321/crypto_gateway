/**
 * EVM blockchain listener — one instance per chain (BSC, Ethereum).
 *
 * Entrypoints: blockchain/listener.ts (BSC) and blockchain/ethListener.ts
 * (Ethereum). Each runs as its OWN PROCESS, which is why the module-level state
 * below (the watch set, the providers, the WS flags) is safe: one process owns
 * exactly one chain.
 *
 * NETWORK SCOPE: every query is filtered to `cfg.network`. That filter is
 * load-bearing, not cosmetic — block numbers and confirmation counts are
 * meaningless across chains, so applying an Ethereum head to a BSC transaction
 * would corrupt its confirmation state. The non-EVM equivalent is
 * blockchain/tronListener.ts.
 *
 * WHAT DIFFERS PER CHAIN is entirely values, held in evmChains.ts: the RPC, the
 * chain id, confirmation and reorg depths, and how many blocks a native scan
 * covers per pass. NOT decimals — those are per-asset (Ethereum USDT is 6 dp,
 * BSC USDT is 18) and come from the asset registry.
 *
 * Two complementary mechanisms keep payment state in sync with the chain:
 *
 *  1. LIVE SUBSCRIPTION (fast path): a WS subscription to USDT `Transfer` events.
 *     When `to` is a known deposit address we immediately upsert a
 *     blockchain_transactions row and move the payment waiting -> confirming.
 *     WS can drop events (reconnects, gaps) — so it is best-effort ONLY.
 *
 *  2. POLLING RECONCILER (source of truth): every ~5s we scan the block range
 *     (last_scanned_block, head - REORG_DEPTH] with queryFilter. This:
 *       - catches events the WS missed,
 *       - updates confirmations = head - block_number,
 *       - promotes payments to `confirmed` at >= required_confirmations and
 *         enqueues the confirmed webhook + a sweep job (idempotently),
 *       - advances chain_cursor.last_scanned_block only up to the safe head,
 *         and only over a range it actually finished scanning with an address
 *         set that already contained every address those blocks could have
 *         been paying (see the ordering note in reconcileOnce — nothing ever
 *         re-scans a block behind the cursor, so that ordering is the only
 *         thing standing between a mid-pass payment and a lost deposit).
 *
 *  REORG SAFETY: we only treat blocks older than REORG_DEPTH as final, and we
 *  re-scan a rolling window behind the head. If a previously-recorded tx is no
 *  longer present on the canonical chain (getTransactionReceipt returns null or a
 *  different block), we mark its blockchain_transactions row `reorged` and revert
 *  the payment out of confirmed. Every write is idempotent:
 *     - blockchain_transactions has UNIQUE (tx_hash, log_index) -> ON CONFLICT.
 *     - status transitions are guarded by WHERE clauses so replays are no-ops.
 */
import { Contract, WebSocketProvider, JsonRpcProvider, Log } from 'ethers';
import { logger } from '../config/logger';
import { pool, query, queryOne } from '../db/pool';
import {
  httpProviderFor,
  nativeScanProviderFor,
  wsProviderFor,
  tokenContract,
  fromBaseUnits,
} from './usdt';
import { Asset, nativeAssetFor, tokenAssetsFor } from './assets';
import { recordUnexpectedDeposit } from '../services/unexpectedDepositService';
import { sweepQueue, SweepJob } from '../workers/queues';
import { enqueueWebhook } from '../services/webhookService';
import { EvmChainConfig } from './evmChains';

/**
 * The chain this process owns. Set once by `runEvmListener` before anything
 * else runs — module-level because there is exactly one chain per process.
 *
 * NOTE ON THE SQL BELOW: `cfg.network` is interpolated directly into the query
 * strings (`AND network = '${cfg.network}'`) rather than bound as a parameter.
 * That is safe here and only here: the value is a member of the `Network` string
 * union, chosen at startup from a constant in evmChains.ts, and never touches a
 * request. It is interpolated because these filters sit inside shared SQL
 * fragments where threading an extra positional parameter through every call
 * site would renumber the placeholders in queries that already carry several —
 * which is its own class of bug. Anything that ever becomes caller-supplied must
 * be bound, not interpolated.
 */
let cfg: EvmChainConfig;

/** chain_cursor key for the native block scanner, e.g. 'BEP20_NATIVE'. */
function nativeCursorKey(): string {
  return `${cfg.network}_NATIVE`;
}

// In-memory set of active deposit addresses (lowercased). Refreshed periodically.
const depositAddresses = new Set<string>();

/**
 * SQL for a payment's received total: the sum of its non-reorged incoming
 * transfers. Used instead of assigning a single transfer's value — see
 * recordIncoming for why that was wrong.
 */
const RECEIVED_SUM = `COALESCE((
              SELECT SUM(bt.amount)
                FROM blockchain_transactions bt
               WHERE bt.payment_id = payments.id
                 AND bt.direction = 'incoming'
                 AND bt.status <> 'reorged'
            ), 0)`;

const RECONCILE_INTERVAL_MS = 5_000;
/**
 * Backstop refresh of the watch set.
 *
 * The load-bearing refresh is now the one at the top of every pass (see
 * reconcileOnce / reconcileNativeOnce): the set MUST be at least as new as the
 * head we are about to scan up to, or the cursor advances over blocks that were
 * filtered by an address set which did not yet contain a freshly-minted deposit
 * address. This timer only keeps the WS fast path's set from going stale while
 * the reconciler itself is failing (a dead RPC makes every pass throw before it
 * reaches the refresh).
 */
const ADDRESS_REFRESH_MS = 30_000;
// How many blocks to scan per reconciler pass (bounded to respect RPC limits).
const MAX_SCAN_RANGE = 2_000;
/**
 * Floor for the ADAPTIVE scan range. A provider that rejects a 2,000-block
 * eth_getLogs ("query returned more than N results", "rate limit") used to be
 * fatal: the identical oversized request was reissued every 5 s forever and the
 * cursor never moved. The range now halves on every failed pass down to this
 * floor and doubles back up after a clean one, so the reconciler negotiates a
 * range the endpoint will actually serve instead of wedging on one it will not.
 */
const MIN_SCAN_RANGE = 10;
let scanRange = MAX_SCAN_RANGE;

/**
 * How many watched addresses go into ONE eth_getLogs topic filter.
 *
 * The watch set is unbounded — it is every deposit address with a live payment
 * — and it is serialised into the request body as a topic OR-list. At a few
 * thousand concurrent payments that body exceeds what public endpoints accept
 * and the call fails wholesale, taking the whole asset's scan with it. Chunking
 * keeps each request bounded; the chunks cover the same address set and the
 * same block range, so nothing is skipped. A chunk that fails only suppresses
 * the cursor advance (see `allOk` below) — the range is then rescanned next
 * pass, and every write on this path is idempotent.
 */
const ADDRESS_FILTER_CHUNK = 200;

/**
 * Consecutive passes that ended without advancing the cursor. A wedged
 * reconciler and a single transient RPC blip produce the same one-line error
 * today; this is what tells them apart.
 */
let stalePasses = 0;
const STALE_PASS_ALARM = 12; // ~1 minute at RECONCILE_INTERVAL_MS

/**
 * Where a deployment with no cursor starts the TOKEN scan: this many blocks
 * behind the safe head. Deliberately a stated number rather than "wherever the
 * head happens to be", because it is the answer to "how late may this process
 * start and still see a deposit that already landed?".
 *
 * Kept below MAX_SCAN_RANGE so the very first pass closes the whole window in
 * one queryFilter. 500 blocks is ~4 minutes on BSC and ~100 minutes on Ethereum
 * — comfortably longer than the gap between an address being minted by the API
 * and this process coming up, on either chain.
 */
const FRESH_CURSOR_LOOKBACK = 500;

/**
 * Say so, loudly and on a throttle, when the cursor is further behind the head
 * than the scanner can close in ~10 passes. A cursor that is millions of blocks
 * behind used to be invisible for days — the pass log is `debug`, so in
 * production the process looked healthy while detecting nothing.
 */
const CURSOR_LAG_WARN_BLOCKS = 10 * MAX_SCAN_RANGE;
const CURSOR_LAG_WARN_INTERVAL_MS = 60_000;
let cursorLagWarnedAt = 0;

/**
 * How long one pass may run before this process is treated as wedged and exits
 * for its supervisor to restart.
 *
 * Sized above ethers' own 300s request timeout (utils/fetch.js sets
 * `#timeout = 300000`), so a merely slow or hanging RPC call resolves itself
 * into an ordinary error before this fires. What it catches is the class of
 * hang that has no timeout at all — see the enqueue section below for the one
 * that motivated it. Exiting is safe: every write in this file is idempotent
 * and lives in Postgres, and both supervisors (compose `restart: unless-stopped`,
 * pm2 autorestart) bring it straight back at the persisted cursor.
 */
const PASS_WEDGE_LIMIT_MS = 6 * 60_000;

/**
 * ======================= ENQUEUING WITHOUT DEPENDING ON REDIS ================
 *
 * The chain pass used to `await` its BullMQ enqueues directly, and that awaited
 * promise could hang FOREVER. BullMQ's connection options set
 * `maxRetriesPerRequest: null` and leave ioredis's `enableOfflineQueue` at its
 * default of true, so while Redis is unreachable a command is parked on an
 * unbounded offline queue and neither settles nor rejects: the two paths that
 * flush that queue both check for things that are not true here (a numeric
 * maxRetriesPerRequest, and a connection closing without a retryStrategy).
 *
 * A try/catch cannot catch a promise that never settles. Because the enqueue
 * sits inside updateConfirmationsAndPromote — which runs BEFORE the reorg check
 * and before the block scan — a Redis outage stopped the listener DETECTING
 * DEPOSITS, not just delivering webhooks. The `running` guard was then never
 * cleared, so every later tick returned immediately and the process logged
 * nothing at all. The damage landed on recovery: a deposit that arrived during
 * the wedge was never recorded, its payment expired on schedule, and the expiry
 * dropped its address out of the watch set — funds at an address nobody watches.
 *
 * So: every enqueue goes through `enqueueOrDefer`, which is bounded by a
 * timeout, and anything that does not get through is HELD IN A FIFO AND RETRIED
 * on later passes rather than dropped. Dropping would trade a wedge for silent
 * fund stranding, which is the worse of the two.
 *
 * What backs this up if the process dies mid-outage and the FIFO goes with it:
 *   - sweep — `payments.status = 'confirmed'` is the durable record. The settle
 *     tick (workers/index.ts processSettle) re-enqueues a sweep for every
 *     confirmed payment, every minute, forever.
 *   - webhook — enqueueWebhook writes its `webhook_logs` row BEFORE it touches
 *     the queue, so an undelivered event is still on the merchant's webhook log
 *     screen with success = false.
 * Neither is a reason to be careless here; both mean a lost enqueue is
 * recoverable rather than invisible.
 *
 * A duplicate is tolerated where a miss is not: if a parked command drains on
 * reconnect AND the retry lands, the merchant gets the same payment.confirmed
 * twice. Webhook delivery is already at-least-once (BullMQ retries), the sweep
 * job id dedupes, and every receiver is documented as keying on paymentId.
 */
type DeferredEnqueue =
  | { kind: 'webhook'; ctx: Parameters<typeof enqueueWebhook>[0] }
  | { kind: 'sweep'; paymentId: string };

interface DeferredItem {
  job: DeferredEnqueue;
  deferredAt: number;
  attempts: number;
}

/** One enqueue may block the pass for this long, and no longer. */
const ENQUEUE_TIMEOUT_MS = 10_000;
/**
 * After a failure, stop touching Redis for this long. Without it a pass that
 * promotes 50 payments would burn 50 timeouts (500s) against a dead Redis and
 * trip the wedge watchdog — turning an outage into a restart loop.
 */
const ENQUEUE_BACKOFF_MS = 30_000;
/** Cap on the held FIFO, and on how much of it one pass will drain. */
const MAX_DEFERRED_ENQUEUES = 5_000;
const DRAIN_PER_PASS = 500;
/**
 * Give up on a held enqueue after this long. Not a Redis-outage timer — six
 * hours is far beyond any survivable outage — but a stop on an item that can
 * never succeed (a client whose webhook_secret no longer decrypts, say) sitting
 * in memory and in the logs forever.
 */
const DEFERRED_MAX_AGE_MS = 6 * 60 * 60 * 1_000;

const deferredEnqueues: DeferredItem[] = [];
let enqueueBlockedUntil = 0;

/**
 * Bound a promise that may never settle. The underlying promise is left running
 * on purpose: if it is an ioredis command parked on the offline queue, it still
 * lands when the connection comes back. Promise.race attaches its own handlers
 * to it, so a late rejection is observed and cannot crash the process.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Hand one job to BullMQ, bounded. Throws on failure OR on timeout. */
async function sendEnqueue(job: DeferredEnqueue): Promise<void> {
  if (job.kind === 'webhook') {
    await withTimeout(enqueueWebhook(job.ctx), ENQUEUE_TIMEOUT_MS, 'webhook enqueue');
    return;
  }
  await withTimeout(
    sweepQueue.add(
      'sweep',
      { paymentId: job.paymentId } as SweepJob,
      { jobId: `sweep-${job.paymentId}` }, // dedupe by payment id (BullMQ forbids ':' in custom ids)
    ),
    ENQUEUE_TIMEOUT_MS,
    'sweep enqueue',
  );
}

function hold(job: DeferredEnqueue): void {
  if (deferredEnqueues.length >= MAX_DEFERRED_ENQUEUES) {
    logger.error(
      { job, held: deferredEnqueues.length },
      'deferred enqueue buffer full — dropping this enqueue. The payment row in ' +
        'postgres is unaffected: the settle tick still re-drives sweeps from ' +
        "status='confirmed', and an undelivered webhook still has its webhook_logs row",
    );
    return;
  }
  deferredEnqueues.push({ job, deferredAt: Date.now(), attempts: 0 });
}

/**
 * Enqueue, or hold for a later pass. NEVER throws and never blocks longer than
 * ENQUEUE_TIMEOUT_MS, so a caller in the chain path can await it safely.
 *
 * Holding while the FIFO is non-empty (rather than sending straight through) is
 * what keeps events for one payment in order: a `payment.confirming` stuck in
 * the queue must not be overtaken by the `payment.confirmed` that follows it.
 */
async function enqueueOrDefer(job: DeferredEnqueue): Promise<void> {
  if (deferredEnqueues.length > 0 || Date.now() < enqueueBlockedUntil) {
    hold(job);
    return;
  }
  try {
    await sendEnqueue(job);
  } catch (err) {
    enqueueBlockedUntil = Date.now() + ENQUEUE_BACKOFF_MS;
    logger.error({ err, job }, 'enqueue failed or timed out — held for retry, chain pass continues');
    hold(job);
  }
}

/**
 * Retry held enqueues, oldest first. Called once per reconciler pass, after the
 * chain work, and never from the native loop — a single drainer means the shift
 * below cannot race another and send the same job twice.
 */
async function drainDeferredEnqueues(): Promise<void> {
  if (deferredEnqueues.length === 0 || Date.now() < enqueueBlockedUntil) return;

  const held = deferredEnqueues.length;
  let sent = 0;
  while (deferredEnqueues.length > 0 && sent < DRAIN_PER_PASS) {
    const item = deferredEnqueues[0];
    if (Date.now() - item.deferredAt > DEFERRED_MAX_AGE_MS) {
      deferredEnqueues.shift();
      logger.error(
        { job: item.job, attempts: item.attempts, ageMs: Date.now() - item.deferredAt },
        'held enqueue abandoned after repeated failures — needs an operator; ' +
          'the payment and webhook_logs rows in postgres still describe it',
      );
      continue;
    }
    try {
      await sendEnqueue(item.job);
    } catch (err) {
      item.attempts += 1;
      enqueueBlockedUntil = Date.now() + ENQUEUE_BACKOFF_MS;
      // Nothing is discarded on failure. After a few attempts the item goes to
      // the BACK instead of staying at the head, so one permanently-failing job
      // cannot hold up every job behind it once Redis is healthy again.
      if (item.attempts >= 3) deferredEnqueues.push(deferredEnqueues.shift()!);
      logger.error(
        { err, held: deferredEnqueues.length, attempts: item.attempts },
        'held enqueue still failing; retrying on a later pass',
      );
      return;
    }
    deferredEnqueues.shift();
    sent += 1;
  }
  logger.info({ sent, held, remaining: deferredEnqueues.length }, 'drained held enqueues');
}

/**
 * ============================ NATIVE (BNB) DETECTION =========================
 * A BNB transfer emits NOTHING. There is no contract, so there is no `Transfer`
 * log to filter — the entire log-based mechanism above is blind to it. The only
 * way to see one is to read the transactions in each block and check their `to`.
 *
 * That is far more expensive per block than a log filter, so the native scan
 * gets its OWN cursor and its OWN (much smaller) range budget:
 *
 *   - Its own cursor row means a native backlog can never stall token scanning,
 *     and vice versa. Sharing one cursor would make the slower of the two
 *     dictate the pace of both, and a native scan that fell behind would drag
 *     the token cursor back over ground it had already covered.
 *
 *   - The smaller range keeps one pass bounded. At BSC's ~0.45s block time a
 *     5s pass covers about 11 new blocks, so 40 is ~4x headroom for catching up
 *     while staying inside what a public RPC will serve. This was 200 until a
 *     live run showed a public node rejecting the burst; see nativeScanProvider
 *     in usdt.ts for the other half of that fix.
 *
 * WHAT THIS CANNOT SEE, STATED PLAINLY: BNB moved by a CONTRACT (an "internal"
 * transfer — a router refund, a multisig disbursement) is not a top-level
 * transaction and does not appear here. Catching those needs `debug_traceBlock`,
 * which public BSC RPCs do not expose; adding it would mean a dependency on an
 * archive provider, which is R6's problem and not this one.
 *
 * The practical exposure is small — a customer paying from a wallet or an
 * exchange withdrawal sends a plain transaction, which is every realistic case —
 * and it is not a LOSS: such a deposit still lands at an HD address whose key is
 * derivable, so backend/src/recover.ts can sweep it by index. It is invisible
 * until someone looks, exactly as wrong-asset deposits were before R3. If that
 * ever becomes a real problem, the fix is a traced or provider-indexed scan, not
 * a wider block filter.
 */
// Blocks per native pass comes from the chain config: BSC's 0.45s blocks and
// Ethereum's ~12s ones need very different budgets.


let httpRpc: JsonRpcProvider;
/** Non-batching provider used ONLY for native block fetches — see usdt.ts. */
let nativeRpc: JsonRpcProvider;

async function refreshDepositAddresses(): Promise<void> {
  const rows = await query<{ address: string }>(
    `SELECT DISTINCT deposit_address AS address
       FROM payments
      WHERE status IN ('waiting', 'confirming', 'partial')
        AND network = '${cfg.network}'`,
  );
  // Also include any deposit wallet with an active-ish payment; the query above
  // is the practical set we must watch.
  //
  // clear()+fill is atomic with respect to the rest of this process: everything
  // after the await above is synchronous, so no handler can ever observe the
  // empty set even though two loops call this.
  const before = depositAddresses.size;
  depositAddresses.clear();
  for (const r of rows) depositAddresses.add(r.address.toLowerCase());
  // Runs on every pass now (every ~5s), so a per-call info line would be pure
  // noise. Only a change in the set is worth saying out loud.
  if (depositAddresses.size !== before) {
    logger.info(
      { count: depositAddresses.size, previous: before },
      'refreshed deposit address watch set',
    );
  } else {
    logger.debug({ count: depositAddresses.size }, 'refreshed deposit address watch set');
  }
}

/**
 * Record an incoming Transfer against a payment (idempotent).
 * Moves the payment waiting -> confirming and stores amount_received + tx_hash.
 */
async function recordIncoming(params: {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  blockNumber: number;
  /** Which token this log belongs to — resolved from the log's contract. */
  asset: Asset;
}): Promise<void> {
  const { txHash, logIndex, from, to, value, blockNumber, asset } = params;

  // Match the deposit address to a live payment AWAITING THIS ASSET.
  //
  // The asset filter is load-bearing, not cosmetic. A deposit address is derived
  // per payment, but nothing stops a customer sending a different supported
  // token to it. Without this clause a USDC transfer would be credited against a
  // payment expecting USDT — a 1:1 credit of the wrong asset, straight into a
  // balance the merchant can withdraw. Unmatched transfers are ignored here;
  // recovering them is the wrong-payment flow, which is deliberately separate.
  const payment = await queryOne<{
    id: string;
    amount: string;
    status: string;
    required_confirmations: number;
  }>(
    `SELECT id, amount, status, required_confirmations
       FROM payments
      WHERE lower(deposit_address) = lower($1)
        AND status IN ('waiting', 'confirming', 'partial')
        AND network = '${cfg.network}'
        AND asset = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [to, asset.symbol],
  );
  if (!payment) {
    // Either not our address at all, or OUR address receiving the WRONG asset.
    // The second case is money that would otherwise sit invisible at a derivable
    // HD address until someone went looking, so record it for recovery. It is
    // deliberately NOT credited to the payment: doing so would put the wrong
    // asset into a withdrawable balance at 1:1.
    await recordUnexpectedDeposit({
      network: cfg.network,
      asset,
      amountHuman: fromBaseUnits(value, asset),
      depositAddress: to,
      txHash,
      logIndex,
    });
    return;
  }

  // Scaled by THIS asset's decimals — using a chain default would mis-scale any
  // token whose decimals differ.
  const amountHuman = fromBaseUnits(value, asset);

  // Upsert the blockchain_transactions row. UNIQUE (tx_hash, log_index) makes this
  // safe to call repeatedly (WS + reconciler may both see the same log).
  await query(
    `INSERT INTO blockchain_transactions
       (payment_id, direction, tx_hash, from_address, to_address, amount, token,
        network, block_number, confirmations, status, log_index, asset)
     VALUES ($1, 'incoming', $2, $3, $4, $5, $8, $9, $6, 0, 'pending', $7, $8)
     ON CONFLICT (tx_hash, log_index)
     DO UPDATE SET block_number = EXCLUDED.block_number,
                   status = CASE WHEN blockchain_transactions.status = 'reorged'
                                 THEN 'pending' ELSE blockchain_transactions.status END`,
    [
      payment.id,
      txHash,
      from,
      to,
      amountHuman,
      blockNumber,
      logIndex,
      asset.symbol,
      cfg.network,
    ],
  );

  // Move waiting -> confirming and refresh amount_received/tx_hash. Guarded so it
  // only advances the state; never downgrades a confirmed payment here.
  //
  // amount_received is RECOMPUTED from the transaction rows, not set to this
  // transfer's value. Assigning the single value was wrong three ways: a customer
  // paying in two transfers had the first overwritten by the second, so the
  // merchant's balance under-counted and their own payout was then rejected as
  // "exceeds available balance"; a reorg needed a special case to undo it; and
  // only an assignment (never `+=`) was safe, because the WS fast path and the
  // polling reconciler both see the same log.
  //
  // The sum has none of those problems. UNIQUE (tx_hash, log_index) means a
  // doubly-seen log contributes one row, and excluding 'reorged' makes the total
  // self-correct when a transfer falls off the chain.
  await query(
    `UPDATE payments
        SET amount_received = ${RECEIVED_SUM},
            tx_hash = $2,
            status = CASE WHEN status = 'waiting' THEN 'confirming' ELSE status END
      WHERE id = $1
        AND status IN ('waiting', 'confirming', 'partial')`,
    [payment.id, txHash],
  );

  logger.info(
    { paymentId: payment.id, txHash, amount: amountHuman, asset: asset.symbol },
    'incoming transfer recorded (confirming)',
  );

  // Emit 'payment.confirming' exactly once — only when this incoming transfer
  // actually moved the payment out of 'waiting'.
  //
  // Not awaited, exactly as before — detection must not wait on a queue — but it
  // now goes through enqueueOrDefer, so an unreachable Redis holds it for retry
  // instead of parking it on an unbounded offline queue that never settles.
  if (payment.status === 'waiting') {
    void enqueueOrDefer({
      kind: 'webhook',
      ctx: { paymentId: payment.id, event: 'payment.confirming' },
    });
  }
}

// --- WS lifecycle state (single-flight + exponential backoff) ---------------
// The WS subscription is a BEST-EFFORT fast path only; the polling reconciler is
// the source of truth. A missing/unreachable WS endpoint must therefore NEVER
// crash the process — we log, tear down, and retry with backoff while polling
// keeps running.
let wsActive = false;
let wsRetryMs = 3_000;
const WS_RETRY_MAX_MS = 60_000;

function scheduleWsRetry(): void {
  const delay = wsRetryMs;
  wsRetryMs = Math.min(WS_RETRY_MAX_MS, wsRetryMs * 2);
  setTimeout(() => void startWsSubscription(), delay);
}

/**
 * Subscribe to live Transfer events over WS. Best-effort fast path.
 * Disabled (no-op) when BSC_WS_RPC is empty. All failure modes are non-fatal.
 */
async function startWsSubscription(): Promise<void> {
  if (!cfg.wsRpc) {
    logger.warn('BSC_WS_RPC not set — live WS subscription disabled; using polling reconciler only');
    return;
  }
  if (wsActive) return; // a subscription is already live
  wsActive = true;

  let ws: WebSocketProvider;
  try {
    ws = wsProviderFor(cfg.wsRpc, cfg.chainId);
  } catch (err) {
    wsActive = false;
    logger.error({ err }, 'failed to create WS provider; retrying (reconciler still running)');
    scheduleWsRetry();
    return;
  }

  // Called on ANY WS failure. Guarded so 'error' + 'close' firing together only
  // triggers one teardown/retry.
  const teardownAndRetry = (reason: string, err?: unknown): void => {
    if (!wsActive) return;
    wsActive = false;
    logger.warn({ reason, err }, 'WS down; resubscribing with backoff (polling unaffected)');
    // Defer destroy() to a microtask and swallow BOTH sync throws and async
    // rejections. Destroying an errored provider makes ethers reject its pending
    // eth_subscribe ("provider destroyed"), which would otherwise crash the
    // process from inside this socket-error callback.
    Promise.resolve()
      .then(() => ws.destroy())
      .catch(() => undefined);
    scheduleWsRetry();
  };

  // CRITICAL: attach an 'error' handler to the underlying socket. Without it,
  // an unreachable host emits an unhandled 'error' event and Node kills the
  // whole process (the exact ENOTFOUND crash this replaced).
  const socket = (
    ws as unknown as {
      websocket?: { on?: (ev: string, cb: (arg?: unknown) => void) => void };
    }
  ).websocket;
  if (socket && typeof socket.on === 'function') {
    socket.on('error', (err) => teardownAndRetry('socket error', err));
    socket.on('close', () => teardownAndRetry('socket close'));
  }
  // Provider-level safety net (in case the socket isn't exposed yet).
  (ws as unknown as { on?: (ev: string, cb: (e: unknown) => void) => void }).on?.(
    'error',
    (err) => teardownAndRetry('provider error', err),
  );

  try {
    // One subscription per enabled asset. Each closes over its own asset, so the
    // handler always knows which token the log belongs to — a single shared
    // subscription would have to re-derive it from the log's address anyway.
    const assets = tokenAssetsFor(cfg.network);
    for (const asset of assets) {
      const token: Contract = tokenContract(ws, asset);
      await token.on(
        'Transfer',
        async (from: string, to: string, value: bigint, event: { log: Log }) => {
          try {
            if (!depositAddresses.has(to.toLowerCase())) return;
            const log = event.log;
            await recordIncoming({
              txHash: log.transactionHash,
              logIndex: log.index,
              from,
              to,
              value,
              blockNumber: log.blockNumber,
              asset,
            });
          } catch (err) {
            logger.error({ err, asset: asset.symbol }, 'error handling live Transfer event');
          }
        },
      );
    }
    wsRetryMs = 3_000; // reset backoff on a clean subscribe
    logger.info(
      { assets: assets.map((a) => a.symbol) },
      'subscribed to Transfer events (WS)',
    );
  } catch (err) {
    teardownAndRetry('subscribe failed', err);
  }
}

/**
 * Scan a bounded block range for NATIVE (BNB) transfers into watched addresses.
 *
 * Everything downstream of detection is shared with the token path: the same
 * `recordIncoming` matches the payment (on asset AS WELL AS address), the same
 * promotion loop confirms it, and the same reorg check reverts it — a plain
 * value transfer has an ordinary receipt, so nothing there needs a special case.
 *
 * `log_index = -1` marks a native row. Real log indexes are non-negative, so
 * this can never collide with a token transfer in the SAME transaction under
 * UNIQUE (tx_hash, log_index) — which is a real possibility, since a contract
 * call can both move BNB and emit a Transfer.
 */
async function scanNativeTransfers(
  asset: Asset,
  fromBlock: number,
  toBlock: number,
  /**
   * A SNAPSHOT of the watch set, taken by the caller after it read the head —
   * deliberately NOT the live `depositAddresses`. See the note in
   * reconcileNativeOnce: the token loop refreshes the same shared set on its own
   * 5s timer, and reading it live mid-scan lets an address disappear between the
   * block being fetched and its transactions being examined, which silently
   * drops a deposit out of a block the cursor is about to move past.
   */
  watched: ReadonlySet<string>,
): Promise<void> {
  for (let n = fromBlock; n <= toBlock; n++) {
    // `true` prefetches full transaction objects — the whole point here, since
    // a native transfer exists only as a transaction, never as a log.
    //
    // On `nativeRpc`, not the shared provider: these go out one at a time so a
    // public node does not see (and reject) them as one oversized batch.
    const block = await nativeRpc.getBlock(n, true);
    if (!block) continue;

    for (const tx of block.prefetchedTransactions) {
      // A zero-value transaction is a contract call, not a payment.
      if (!tx.to || tx.value <= 0n) continue;
      if (!watched.has(tx.to.toLowerCase())) continue;

      await recordIncoming({
        txHash: tx.hash,
        logIndex: -1,
        from: tx.from,
        to: tx.to,
        value: tx.value,
        blockNumber: n,
        asset,
      });
    }
  }
}

/**
 * Advance (or initialise) the TOKEN scanner's cursor for this chain.
 *
 * An upsert rather than a bare UPDATE, matching the native path. The seed rows
 * in sql/schema.sql cover today's networks, but a chain added by a later
 * migration that forgot its seed would make every write here affect zero rows —
 * and a cursor that never advances rescans the same range forever while the
 * head runs away from it.
 */
async function writeTokenCursor(block: number): Promise<void> {
  await query(
    `INSERT INTO chain_cursor (network, last_scanned_block) VALUES ($1, $2)
     ON CONFLICT (network) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block`,
    [cfg.network, block],
  );
}

/**
 * Reconciler: scan a bounded range behind the head, update confirmations, promote
 * to confirmed, detect reorgs, and advance the cursor.
 */
async function reconcileOnce(): Promise<void> {
  const head = await httpRpc.getBlockNumber();
  const safeHead = head - cfg.reorgDepth;
  if (safeHead <= 0) return;

  // ===================== ORDERING IS THE CORRECTNESS ARGUMENT ================
  // The watch set is refreshed HERE — after the head is read, and before the
  // range derived from that head is scanned. That order is what makes the
  // cursor advance safe, and it is not interchangeable:
  //
  //   Every block <= `head` was already mined when getBlockNumber() returned.
  //   A deposit address that is missing from the set refreshed AFTER that
  //   moment therefore did not exist when the address's payment was created —
  //   the payment is younger than `head`, so any transfer to it can only be
  //   mined in a block ABOVE `head`, which is above `scanTo` and will be
  //   scanned by a later pass with a set that does contain it.
  //
  // With the refresh on its own independent 30 s timer (what this replaced) the
  // opposite could happen: a payment created mid-pass had its address absent
  // from the filter, its deposit produced no logs, and the cursor still moved
  // past the block it was in. Nothing rescans a block behind the cursor, so
  // that deposit was never seen again — no row, no log, no unexpected_deposits
  // entry, the payment simply expired.
  await refreshDepositAddresses();

  const cursorRow = await queryOne<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM chain_cursor WHERE network = '${cfg.network}'`,
  );
  let lastScanned = Number(cursorRow?.last_scanned_block ?? 0);

  if (lastScanned <= 0) {
    // A fresh deployment has no cursor, and 0 was being taken LITERALLY: the
    // token scan started at block 1 and walked forward MAX_SCAN_RANGE per 5s
    // pass — 400 blocks/s against a chain producing ~2/s. On a BSC deployment
    // at block ~60M that is ~42 hours of scanning empty history while real
    // payments land at the head, unseen; with BSC_WS_RPC unset (supported, see
    // startWsSubscription) there is no other detection path at all.
    //
    // 0 means UNINITIALISED here, never "scanned to genesis" — chain_cursor
    // seeds every network at 0 (sql/schema.sql) and no chain this gateway
    // settles on has a payment in block 0. The native scanner below has always
    // read it that way; the token scanner simply never got the same guard.
    //
    // Persisted IMMEDIATELY, before any scanning. If this pass then fails on a
    // dead RPC or a rejected queryFilter, the next one resumes from the block
    // we chose; re-deriving it from a head that has moved on would leave the
    // blocks in between scanned by nobody.
    lastScanned = Math.max(0, safeHead - FRESH_CURSOR_LOOKBACK);
    await writeTokenCursor(lastScanned);
    logger.warn(
      { network: cfg.network, safeHead, startFrom: lastScanned + 1, lookback: FRESH_CURSOR_LOOKBACK },
      'token scan cursor was uninitialised — starting near the chain head, not at genesis',
    );
  } else {
    const behind = safeHead - lastScanned;
    if (behind > CURSOR_LAG_WARN_BLOCKS && Date.now() - cursorLagWarnedAt > CURSOR_LAG_WARN_INTERVAL_MS) {
      cursorLagWarnedAt = Date.now();
      logger.warn(
        { network: cfg.network, behind, lastScanned, safeHead },
        'token scan cursor is far behind the chain head — deposits in the gap are not detected yet',
      );
    }
  }

  // 1) Detect reorgs among recently-recorded (not-yet-final) incoming txs.
  //    Ahead of promotion so a transfer that has just fallen off the canonical
  //    chain is not promoted and then immediately reverted in the same pass.
  await detectReorgs(head);

  // 2) Scan for missed events in (lastScanned, scanTo].
  const fromBlock = lastScanned + 1;
  const scanTo = Math.min(safeHead, fromBlock + scanRange - 1);
  const nothingToScan = scanTo < fromBlock;

  // Every queryFilter of this pass succeeded. The cursor may ONLY advance when
  // this is still true — a failed chunk means blocks in (fromBlock, scanTo]
  // were not fully examined, and nothing behind the cursor is ever rescanned.
  let allOk = true;

  // Only scan if we're actually watching addresses. Filtering the `to` topic by
  // our deposit set is ESSENTIAL: an unfiltered Transfer scan on BSC returns
  // millions of logs and public RPCs reject it ("more than N results"). With no
  // active addresses there is nothing to find, so we just advance the cursor.
  if (!nothingToScan && depositAddresses.size > 0) {
    // One queryFilter per enabled asset. Kept per-contract rather than one merged
    // filter because ethers resolves the event topic from the contract instance,
    // and — more importantly — a failure on one token must not silently drop the
    // others' logs while the cursor advances past them.
    //
    // SNAPSHOT, and every later membership test in this pass is against the
    // SNAPSHOT — not against the live `depositAddresses`. The set is shared with
    // the native loop, which refreshes it on its own timer every ~5s, and this
    // block awaits a queryFilter per (asset, chunk) plus a recordIncoming per
    // log, so a refresh lands in the middle of it routinely. With the live set,
    // a payment that settled or expired mid-pass had its address removed and the
    // defensive re-check below then DROPPED a log the RPC had already returned —
    // while `allOk` stayed true and the cursor moved past the block it was in.
    // That is the silent-loss shape this whole ordering rule exists to prevent:
    // recordIncoming is never reached, so there is not even an
    // unexpected_deposits row to find it by.
    const watched = Array.from(depositAddresses);
    const watchedSet = new Set(watched);
    for (const asset of tokenAssetsFor(cfg.network)) {
      const token = tokenContract(httpRpc, asset);
      // Chunked so one request never carries an unbounded topic list. Every
      // chunk covers the SAME block range, so the union is the whole range for
      // the whole watch set.
      for (let i = 0; i < watched.length; i += ADDRESS_FILTER_CHUNK) {
        const batch = watched.slice(i, i + ADDRESS_FILTER_CHUNK);
        // Transfer(from, to): filter on the indexed `to` topic by this chunk (OR).
        const filter = token.filters.Transfer(null, batch);
        let logs: Log[] = [];
        try {
          logs = (await token.queryFilter(filter, fromBlock, scanTo)) as unknown as Log[];
        } catch (err) {
          // Do NOT return. A `return` here used to abandon every REMAINING
          // asset's scan as well, so one rate-limited token silently starved the
          // others. Carry on, and let `allOk` hold the cursor back instead.
          allOk = false;
          logger.error(
            {
              err,
              fromBlock,
              scanTo,
              scanRange,
              asset: asset.symbol,
              batchStart: i,
              batchSize: batch.length,
            },
            'queryFilter failed; cursor held, range narrowed, retrying next pass',
          );
          continue;
        }

        for (const raw of logs) {
          // queryFilter returns EventLog with parsed args in v6.
          const evt = raw as unknown as {
            args?: { from: string; to: string; value: bigint };
            transactionHash: string;
            index: number;
            blockNumber: number;
          };
          if (!evt.args) continue;
          const to = evt.args.to;
          // Defensive: the RPC must only ever return logs for addresses this
          // pass actually asked about. Tested against the pass's own snapshot so
          // a concurrent refresh cannot turn it into a silent drop.
          if (!watchedSet.has(to.toLowerCase())) continue;
          await recordIncoming({
            txHash: evt.transactionHash,
            logIndex: evt.index,
            from: evt.args.from,
            to,
            value: evt.args.value,
            blockNumber: evt.blockNumber,
            asset,
          });
        }
      }
    }
  }

  // 3) Confirmations + promotion, ONCE per pass, and AFTER the scan so it also
  //    covers whatever the scan just discovered. It deliberately sits before
  //    every early return below: a pass whose scan failed must still advance
  //    confirmations, promote what has reached depth, and fire the confirmed
  //    webhook + sweep. Only DISCOVERY stalls on an RPC failure, never
  //    settlement of what is already recorded.
  await updateConfirmationsAndPromote(head);

  if (nothingToScan) {
    // Caught up to the safe head — there is no unscanned range being held back.
    stalePasses = 0;
    return;
  }

  if (!allOk) {
    stalePasses += 1;
    if (stalePasses === STALE_PASS_ALARM || stalePasses % (STALE_PASS_ALARM * 10) === 0) {
      logger.error(
        { network: cfg.network, stalePasses, fromBlock, scanTo, scanRange, behind: safeHead - lastScanned },
        'reconciler has not advanced its cursor for many consecutive passes — ' +
          'deposits in the unscanned range are NOT being detected; check the RPC endpoint',
      );
    }
    // Narrow the window we ask for. A provider that refuses 2,000 blocks will
    // usually serve 1,000, and the floor keeps this from collapsing to nothing.
    scanRange = Math.max(MIN_SCAN_RANGE, Math.floor(scanRange / 2));
    return; // do NOT advance the cursor — retry the same range next pass
  }

  // Clean pass: widen back towards the budget so a one-off blip does not pin the
  // scanner at a narrow range forever (which would make catch-up take hours).
  scanRange = Math.min(MAX_SCAN_RANGE, scanRange * 2);
  stalePasses = 0;
  await writeTokenCursor(scanTo);
  logger.debug(
    { fromBlock, scanTo, head, behind: safeHead - scanTo },
    'reconciler pass complete',
  );
}

/**
 * Native (BNB) pass. Kept entirely separate from the token reconciler above so
 * that a failure or a backlog on either side cannot affect the other — they
 * advance independent cursors over the same chain.
 *
 * A no-op unless a native asset is enabled, so a deployment that never sets
 * ACCEPT_NATIVE_COINS makes zero extra RPC calls.
 */
async function reconcileNativeOnce(): Promise<void> {
  const asset = nativeAssetFor(cfg.network);
  if (!asset) return;

  const head = await nativeRpc.getBlockNumber();
  const safeHead = head - cfg.reorgDepth;
  if (safeHead <= 0) return;

  // Same ordering rule as the token pass, for the same reason: the watch set
  // must be at least as new as the head whose blocks this pass will mark as
  // scanned. See the note in reconcileOnce. This loop has its OWN cursor, so it
  // cannot lean on the token pass's refresh — the two advance independently.
  await refreshDepositAddresses();

  const cursorRow = await queryOne<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM chain_cursor WHERE network = $1`,
    [nativeCursorKey()],
  );
  // A first run with no cursor must NOT start from block 0 — that would try to
  // walk the entire chain one block at a time. Start at the safe head: a payment
  // cannot have been paid before this gateway knew how to accept it.
  const lastScanned = Number(cursorRow?.last_scanned_block ?? 0) || safeHead - 1;

  const fromBlock = lastScanned + 1;
  const scanTo = Math.min(safeHead, fromBlock + cfg.nativeScanRange - 1);
  if (scanTo < fromBlock) return;

  // SNAPSHOT the watch set for the whole scan, rather than reading the shared
  // set live inside it. `depositAddresses` is shared with the token loop, which
  // refreshes it on its own pass every ~5s; this scan walks blocks one RPC call
  // at a time and can easily still be running across several of those. Reading
  // it live meant a payment that settled or expired mid-scan had its address
  // removed underneath us, and a native transfer to it in an ALREADY-FETCHED
  // block was then skipped — with the cursor advancing past that block anyway.
  // Nothing rescans behind the cursor, so that deposit became invisible: no
  // blockchain_transactions row and, because recordIncoming was never reached,
  // no unexpected_deposits row either.
  //
  // The snapshot cannot miss the opposite way. It is taken after the head was
  // read, so by the ordering argument above it already contains every address
  // that any block <= scanTo could have been paying.
  const watched = new Set(depositAddresses);

  // Nothing to look for. Advance the cursor anyway so an idle period does not
  // build a backlog that has to be walked block by block when a payment appears.
  if (watched.size > 0) {
    try {
      await scanNativeTransfers(asset, fromBlock, scanTo, watched);
    } catch (err) {
      logger.error(
        { err, fromBlock, scanTo },
        'native block scan failed; will retry the same range next pass',
      );
      return; // do NOT advance the cursor
    }
  }

  await updateConfirmationsAndPromote(head);
  await query(
    `INSERT INTO chain_cursor (network, last_scanned_block) VALUES ($1, $2)
     ON CONFLICT (network) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block`,
    [nativeCursorKey(), scanTo],
  );
  logger.debug(
    { fromBlock, scanTo, head, behind: safeHead - scanTo },
    'native reconciler pass complete',
  );
}

/**
 * How far behind the head a `pending` incoming row can still be moved by the
 * confirmations UPDATE below.
 *
 * `required_confirmations` is written once at payment creation from
 * `adapter.requiredConfirmations` (services/paymentService.ts) — i.e. always
 * `cfg.requiredConfirmations` for this chain — so that term is exact, not a
 * guess. `reorgDepth` covers the gap between the head and the safe head, and one
 * full MAX_SCAN_RANGE covers a catch-up pass that discovers a transfer up to a
 * whole scan window behind the head.
 */
function confirmationWindowBlocks(): number {
  return cfg.requiredConfirmations + cfg.reorgDepth + MAX_SCAN_RANGE;
}

/**
 * Mark ONE payment's incoming transfers `confirmed`, per row and on the row's
 * own depth. $1 = payment id, $2 = current head.
 *
 * The depth test is joined to `payments.required_confirmations` rather than
 * taken from `bt.confirmations`, because that column is a maintained display
 * value and this is a settlement decision.
 */
function confirmDeepRowsSql(): string {
  return `UPDATE blockchain_transactions bt
             SET status = 'confirmed'
            FROM payments p
           WHERE p.id = bt.payment_id
             AND bt.payment_id = $1
             AND bt.direction = 'incoming'
             AND bt.status = 'pending'
             AND bt.network = '${cfg.network}'
             AND bt.block_number IS NOT NULL
             AND ($2 - bt.block_number) >= p.required_confirmations`;
}

/**
 * Update confirmations = head - block_number for pending incoming txs and promote
 * their payments to `confirmed` at >= required_confirmations. Idempotent: the
 * promotion WHERE clause only fires once (status must still be 'confirming').
 */
async function updateConfirmationsAndPromote(head: number): Promise<void> {
  // Update confirmations on the tx rows. Scoped to BEP20: `head` is a BSC block
  // number and comparing it against a Tron block number is meaningless.
  //
  // BOUNDED BY BLOCK, and the bound cannot starve anything. This statement only
  // maintains the DISPLAY column: every decision below reads depth as
  // `head - bt.block_number` straight from the row, never from `confirmations`.
  // A `pending` row older than the window has, by definition, passed every
  // threshold this chain applies, so the only rows it excludes are ones whose
  // counter is already far past anything that reads it — and the promotion
  // SELECT further down carries NO block bound at all, so they are still picked
  // up and settled. What this removes is the rewrite of every pending row in
  // the table on every pass, forever, against a predicate with no index.
  await query(
    `UPDATE blockchain_transactions
        SET confirmations = GREATEST(0, $1 - block_number)
      WHERE direction = 'incoming'
        AND status = 'pending'
        AND network = '${cfg.network}'
        AND block_number IS NOT NULL
        AND block_number > $1 - $2`,
    [head, confirmationWindowBlocks()],
  );

  // Mirror confirmations onto payments (confirm-tracker).
  await query(
    `UPDATE payments p
        SET confirmations = GREATEST(0, $1 - bt.block_number)
       FROM blockchain_transactions bt
      WHERE bt.payment_id = p.id
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = '${cfg.network}'
        AND p.status IN ('confirming', 'partial')`,
    [head],
  );

  // Find payments that have crossed the confirmation threshold.
  //
  // `fully_paid` is the whole point of this query and was missing. Confirmation
  // DEPTH and payment SUFFICIENCY are two independent questions, and this code
  // only ever asked the first: any nonzero transfer that reached
  // required_confirmations was promoted to `confirmed`, so 0.000001 USDT
  // settled a 500 USDT invoice and fired payment.confirmed at the merchant.
  // `amount_received` was already being maintained (see RECEIVED_SUM) and
  // `partial` already existed in the payment_status enum — the comparison
  // between them simply was not written, which left `partial` a value the
  // schema declared, the queries read, and nothing ever wrote.
  //
  // Compared exactly, with no tolerance. Both columns are NUMERIC(38,18) so the
  // comparison is exact rather than floating point, and "close enough" on the
  // amount a customer owes is a business decision for the operator to make
  // explicitly, not a default to inherit silently.
  //
  // `partial` IS SELECTED HERE, not just `confirming`, and that is what makes
  // the underpayment hold recoverable rather than terminal. The first version of
  // the amount gate matched `p.status = 'confirming'` alone, so once a payment
  // was parked at `partial` nothing could ever select it again: the customer's
  // top-up was recorded (recordIncoming accepts `partial`), amount_received grew
  // past `amount`, and the payment still sat at `partial` forever — never
  // promoted, never swept, never expired, showing on the merchant's balance
  // strip as `pending` (payoutService getAllBalances) with no mechanism anywhere
  // that could move it. That is a fully-paid invoice whose funds stay at the
  // deposit address, which is worse than the underpayment bug it replaced.
  //
  // A settled `partial` costs nothing to re-check: the partial branch below
  // marks its incoming rows `confirmed`, so a payment with no NEW money has no
  // `pending` row left to join against and never reappears in this result.
  //
  // ============ SUFFICIENCY IS MEASURED ON MONEY THAT REACHED DEPTH ==========
  // `fully_paid` sums only the transfers that have INDIVIDUALLY cleared
  // required_confirmations, not `p.amount_received` (which counts every
  // non-reorged row, including one recorded seconds ago by the WS fast path at
  // the live head). Using amount_received here promoted a payment — and fired
  // payment.confirmed, and enqueued the sweep — on the strength of a transfer
  // with ZERO confirmations, as long as some OTHER, older transfer had reached
  // depth. That is money leaving the hot wallet against a deposit with no
  // finality at all.
  //
  // Nothing is stranded by waiting: the shallow transfer's row stays `pending`,
  // so this SELECT re-picks the payment the moment that row reaches depth and
  // promotes it then. If instead the shallow transfer falls off the chain,
  // detectReorgs marks the row `reorged`, it leaves both this sum and
  // amount_received, and the payment drops to `partial` down the branch below —
  // which is the honest answer. The only change is WHEN, bounded by
  // required_confirmations blocks.
  const ready = await query<{ id: string; tx_hash: string | null; fully_paid: boolean }>(
    `SELECT DISTINCT
            p.id,
            p.tx_hash,
            (COALESCE((
               SELECT SUM(d.amount)
                 FROM blockchain_transactions d
                WHERE d.payment_id = p.id
                  AND d.direction = 'incoming'
                  AND d.status <> 'reorged'
                  AND d.block_number IS NOT NULL
                  AND ($1 - d.block_number) >= p.required_confirmations
             ), 0) >= p.amount) AS fully_paid
       FROM payments p
       JOIN blockchain_transactions bt ON bt.payment_id = p.id
      WHERE p.status IN ('confirming', 'partial')
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = '${cfg.network}'
        AND bt.block_number IS NOT NULL
        AND ($1 - bt.block_number) >= p.required_confirmations`,
    [head],
  );

  for (const p of ready) {
    // UNDERPAID. The transfer is final on-chain, but the customer owes more.
    // The payment goes to `partial` and stops here: no payment.confirmed, and
    // no sweep. It stays open, and recordIncoming already accepts `partial` in
    // its WHERE clause, so a top-up transfer to the same deposit address
    // re-enters this path and settles it properly once the balance is covered.
    //
    // Re-entrant on `partial` as well as `confirming`: a top-up that STILL does
    // not cover the invoice lands here a second time, and the point of running
    // the statement again is the blockchain_transactions update below — the new
    // incoming row has to leave `pending`, or it would re-select this payment on
    // every pass forever.
    if (!p.fully_paid) {
      // `amount_received < amount` is re-tested HERE, inside the write, rather
      // than trusted from the SELECT above. This listener records transfers from
      // the live WS subscription as well as from the reconciler pass, so a
      // top-up can land between the two statements: the SELECT reads underpaid,
      // the WS handler credits the balance, and the write would then freeze a
      // now fully-paid invoice as `partial`. Losing the race is harmless — zero
      // rows means the payment is already covered, its transfer rows are still
      // `pending`, and the next pass promotes it properly. Matched to the same
      // guard in tronListener/bitcoinListener so all three behave identically.
      const marked = await query<{ id: string; amount: string; amount_received: string }>(
        `UPDATE payments
            SET status = 'partial'
          WHERE id = $1 AND status IN ('confirming', 'partial')
            AND amount_received < amount
          RETURNING id, amount, amount_received`,
        [p.id],
      );
      if (marked.length === 0) continue;

      // The transaction itself IS confirmed on-chain; only the payment is not
      // satisfied. Leaving the row `pending` would make the reconciler keep
      // re-counting confirmations against it forever.
      //
      // Only the rows that reached depth — see confirmDeepRowsSql. A shallower
      // transfer to the same address stays `pending` ON PURPOSE: that is what
      // brings this payment back into the `ready` SELECT once it matures, which
      // is how a top-up settles a `partial`.
      await query(confirmDeepRowsSql(), [p.id, head]);

      logger.warn(
        {
          paymentId: p.id,
          expected: marked[0].amount,
          received: marked[0].amount_received,
          network: cfg.network,
        },
        'payment underpaid — held as partial, not confirmed, not swept',
      );
      continue;
    }

    // Promote confirming/partial -> confirmed (guarded so it fires exactly
    // once). `partial` is included because that is precisely the topped-up case:
    // the customer covered the shortfall, so the hold is released and the
    // payment settles down the ordinary path from here — webhook, sweep, payout.
    const promoted = await query<{ id: string }>(
      `UPDATE payments
          SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1 AND status IN ('confirming', 'partial')
        RETURNING id`,
      [p.id],
    );
    if (promoted.length === 0) continue; // already promoted by a concurrent pass

    // Mark the tx rows confirmed too — but ONLY those that individually reached
    // required_confirmations.
    //
    // This statement used to confirm EVERY pending incoming row for the payment,
    // with no depth test of its own. One deep transfer therefore stamped
    // `confirmed` on a transfer the WS fast path had recorded seconds earlier at
    // the live head, and that row then looked, to everything downstream, exactly
    // like money with finality. Anything still shallow is left `pending` and is
    // swept up by the statement after this loop once it reaches depth.
    await query(confirmDeepRowsSql(), [p.id, head]);

    logger.info({ paymentId: p.id }, 'payment confirmed');

    // Side effects (idempotent enqueues): webhook + sweep, in that order.
    //
    // Both go through enqueueOrDefer. These two awaits were the wedge: they sat
    // in front of reorg detection and the block scan, and an enqueue against an
    // unreachable Redis never settles, so a Redis outage stopped this listener
    // seeing new deposits. They are now bounded and, when Redis is down, held
    // for a later pass rather than abandoned.
    await enqueueOrDefer({
      kind: 'webhook',
      ctx: { paymentId: p.id, event: 'payment.confirmed' },
    });
    await enqueueOrDefer({ kind: 'sweep', paymentId: p.id });
  }

  // ==================== WHAT PICKS UP THE ROWS LEFT BEHIND ====================
  // Confirming rows one at a time, on their own depth, leaves a real leftover:
  // a shallow transfer that arrived just before its payment was promoted stays
  // `pending`, and its payment is now `confirmed`/`swept` — which the `ready`
  // SELECT above deliberately does not match, so nothing up there would ever
  // look at that row again. It would sit `pending` forever, be rewritten by the
  // confirmations UPDATE on every pass, and misreport itself in the merchant's
  // transaction list.
  //
  // This is that pickup. It is the ONLY statement that touches rows whose
  // payment has already been settled, and it applies the same per-row depth test
  // as everything else. Payments still in `confirming`/`partial` are excluded on
  // purpose: their pending rows are the trigger that brings them back into the
  // promotion path, and confirming those rows early would strand the payment.
  await query(
    `UPDATE blockchain_transactions bt
        SET status = 'confirmed'
       FROM payments p
      WHERE p.id = bt.payment_id
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = '${cfg.network}'
        AND bt.block_number IS NOT NULL
        AND ($1 - bt.block_number) >= p.required_confirmations
        AND p.status IN ('confirmed', 'swept')`,
    [head],
  );
}

/**
 * Reorg detection: for recently-recorded incoming txs that are NOT yet final
 * (within the reorg window), verify the tx still exists on-chain in the same
 * block. If not, mark it `reorged` and revert the payment.
 */
async function detectReorgs(head: number): Promise<void> {
  const windowStart = head - cfg.reorgDepth;
  const candidates = await query<{
    id: string;
    payment_id: string | null;
    tx_hash: string;
    block_number: string;
    status: string;
  }>(
    `SELECT id, payment_id, tx_hash, block_number, status
       FROM blockchain_transactions
      WHERE direction = 'incoming'
        AND status IN ('pending', 'confirmed')
        AND network = '${cfg.network}'
        AND block_number IS NOT NULL
        AND block_number > $1`,
    [windowStart],
  );

  for (const c of candidates) {
    let receipt;
    try {
      receipt = await httpRpc.getTransactionReceipt(c.tx_hash);
    } catch (err) {
      logger.warn({ err, txHash: c.tx_hash }, 'reorg check: receipt lookup failed');
      continue;
    }

    const stillCanonical =
      receipt !== null && Number(receipt.blockNumber) === Number(c.block_number);

    if (stillCanonical) continue;

    // Tx dropped or moved -> reorg. Mark reorged and revert the payment.
    logger.warn(
      { txHash: c.tx_hash, paymentId: c.payment_id },
      'reorg detected: incoming tx no longer canonical; reverting',
    );
    await query(
      `UPDATE blockchain_transactions SET status = 'reorged' WHERE id = $1`,
      [c.id],
    );
    if (c.payment_id) {
      // Revert confirmed/confirming back to waiting and clear tx_hash so the
      // reconciler can re-detect if the tx re-appears in the new canonical chain.
      //
      // amount_received is recomputed rather than zeroed: the row we just marked
      // 'reorged' drops out of the sum, but any OTHER transfer to this address
      // that is still canonical must survive. Zeroing lost those.
      await query(
        `UPDATE payments
            SET status = CASE WHEN status IN ('confirmed','confirming') THEN 'waiting' ELSE status END,
                amount_received = ${RECEIVED_SUM},
                confirmations = 0,
                confirmed_at = NULL,
                tx_hash = NULL
          WHERE id = $1
            AND status IN ('confirmed','confirming')`,
        [c.payment_id],
      );
      // Not awaited (reorg handling must not wait on a queue), but held rather
      // than parked if Redis is unreachable — see enqueueOrDefer.
      void enqueueOrDefer({
        kind: 'webhook',
        ctx: {
          paymentId: c.payment_id,
          event: 'payment.reverted',
          overrides: { status: 'waiting', txHash: null },
        },
      });
    }
  }
}

/**
 * Run `pass` on the reconcile interval, never overlapping, with a watchdog on
 * the guard itself.
 *
 * The guard is cleared only in `finally`, so a pass that never settles used to
 * silence the loop permanently: every later tick returned at `if (running)` and
 * the process printed nothing — not an error, not a pass-complete line — while
 * deposits went undetected. A guard that has been held far longer than any pass
 * can legitimately take is that state, and the only honest reading of it is
 * that this process can no longer make progress.
 *
 * So it exits rather than trying to force the guard: the wedged work is still
 * out there holding whatever it holds, and the state it would have written is
 * derived from Postgres on the next boot anyway.
 */
function startPassLoop(label: string, pass: () => Promise<void>): void {
  let running = false;
  let startedAt = 0;
  setInterval(() => {
    if (running) {
      const stuckMs = Date.now() - startedAt;
      if (stuckMs > PASS_WEDGE_LIMIT_MS) {
        logger.fatal(
          { label, stuckMs, chain: cfg.label, network: cfg.network },
          'listener pass wedged — exiting so the supervisor restarts this process',
        );
        process.exit(1);
      }
      return;
    }
    running = true;
    startedAt = Date.now();
    pass()
      .catch((err) => logger.error({ err }, `${label} pass failed`))
      .finally(() => {
        running = false;
      });
  }, RECONCILE_INTERVAL_MS);
}

/**
 * Start the listener for one EVM chain. Never returns.
 *
 * Call this exactly once per process. `cfg` is module-level state, so a second
 * call in the same process would repoint every timer at a different chain
 * mid-flight — hence the guard.
 */
export async function runEvmListener(chain: EvmChainConfig): Promise<void> {
  if (cfg) {
    throw new Error(
      `an EVM listener for ${cfg.network} is already running in this process; ` +
        `run one chain per process`,
    );
  }
  cfg = chain;

  logger.info(
    { chain: cfg.label, network: cfg.network, rpc: Boolean(cfg.httpRpc) },
    'starting EVM blockchain listener',
  );

  if (!cfg.httpRpc) {
    // Nothing useful can happen without an endpoint, and silently idling would
    // look identical to "no payments yet". Stay alive so a supervisor does not
    // flap, but say why on the way in.
    logger.error(
      { chain: cfg.label },
      'no HTTP RPC configured for this chain — listener idle. Set the chain\'s ' +
        'RPC env var (ETH_HTTP_RPC for Ethereum) and restart.',
    );
    setInterval(() => undefined, 1 << 30);
    return;
  }

  // Resilience net: this process is designed to survive transient RPC/WS faults
  // (all state is idempotent and lives in Postgres). Log stray async faults from
  // the RPC layer instead of letting Node's default handler kill the listener.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandledRejection (listener continues)');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException (listener continues)');
  });

  httpRpc = httpProviderFor(cfg.httpRpc, cfg.chainId);
  nativeRpc = nativeScanProviderFor(cfg.httpRpc, cfg.chainId);

  await refreshDepositAddresses();
  setInterval(() => {
    refreshDepositAddresses().catch((err) =>
      logger.error({ err }, 'address refresh failed'),
    );
  }, ADDRESS_REFRESH_MS);

  await startWsSubscription();

  // Reconciler loop (serialized: never overlap passes).
  startPassLoop('reconciler', async () => {
    try {
      await reconcileOnce();
    } finally {
      // In a `finally` because the two failures are independent: a dead RPC
      // must not also stop held webhooks and sweeps from going out once Redis
      // is back. drainDeferredEnqueues swallows its own errors, so this cannot
      // mask a reconcile failure.
      await drainDeferredEnqueues();
    }
  });

  // Native loop, on its own timer and its own guard. Deliberately NOT chained to
  // the token pass: block scanning is the slower of the two, and running them in
  // sequence would let a native catch-up hold back token detection — which is
  // the path carrying almost all of the value.
  const native = nativeAssetFor(cfg.network);
  if (native) {
    logger.info(
      { asset: native.symbol, chain: cfg.label, scanRange: cfg.nativeScanRange },
      'native coin accepted on this chain; block scanning enabled',
    );
    startPassLoop('native reconciler', reconcileNativeOnce);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal, chain: cfg.label }, 'shutting down listener');
    // Held enqueues live in memory and do not survive this. Say so on the way
    // out rather than letting them disappear quietly — what recovers them is
    // named here so nobody has to go looking for it.
    if (deferredEnqueues.length > 0) {
      logger.error(
        { held: deferredEnqueues.length, chain: cfg.label },
        'exiting with enqueues still held for redis — the settle tick re-drives sweeps ' +
          "from payments.status='confirmed', and each undelivered webhook has a webhook_logs row",
      );
    }
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
