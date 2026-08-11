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
 *       - advances chain_cursor.last_scanned_block only up to the safe head.
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
const ADDRESS_REFRESH_MS = 30_000;
// How many blocks to scan per reconciler pass (bounded to respect RPC limits).
const MAX_SCAN_RANGE = 2_000;

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
  depositAddresses.clear();
  for (const r of rows) depositAddresses.add(r.address.toLowerCase());
  logger.info({ count: depositAddresses.size }, 'refreshed deposit address watch set');
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
  if (payment.status === 'waiting') {
    enqueueWebhook({ paymentId: payment.id, event: 'payment.confirming' }).catch(
      (err) => logger.warn({ err, paymentId: payment.id }, 'confirming webhook enqueue failed'),
    );
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
      if (!depositAddresses.has(tx.to.toLowerCase())) continue;

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
 * Reconciler: scan a bounded range behind the head, update confirmations, promote
 * to confirmed, detect reorgs, and advance the cursor.
 */
async function reconcileOnce(): Promise<void> {
  const head = await httpRpc.getBlockNumber();
  const safeHead = head - cfg.reorgDepth;
  if (safeHead <= 0) return;

  const cursorRow = await queryOne<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM chain_cursor WHERE network = '${cfg.network}'`,
  );
  const lastScanned = Number(cursorRow?.last_scanned_block ?? 0);

  // 1) Update confirmations + promote confirmed for all pending incoming txs.
  await updateConfirmationsAndPromote(head);

  // 2) Detect reorgs among recently-recorded (not-yet-final) incoming txs.
  await detectReorgs(head);

  // 3) Scan for missed events in (lastScanned, scanTo].
  const fromBlock = lastScanned + 1;
  const scanTo = Math.min(safeHead, fromBlock + MAX_SCAN_RANGE - 1);
  if (scanTo < fromBlock) {
    // Nothing new safe to scan yet.
    return;
  }

  // Only scan if we're actually watching addresses. Filtering the `to` topic by
  // our deposit set is ESSENTIAL: an unfiltered Transfer scan on BSC returns
  // millions of logs and public RPCs reject it ("more than N results"). With no
  // active addresses there is nothing to find, so we just advance the cursor.
  if (depositAddresses.size > 0) {
    // One queryFilter per enabled asset. Kept per-contract rather than one merged
    // filter because ethers resolves the event topic from the contract instance,
    // and — more importantly — a failure on one token must not silently drop the
    // others' logs while the cursor advances past them.
    const watched = Array.from(depositAddresses);
    for (const asset of tokenAssetsFor(cfg.network)) {
      const token = tokenContract(httpRpc, asset);
      // Transfer(from, to): filter on the indexed `to` topic by our watch set (OR).
      const filter = token.filters.Transfer(null, watched);
      let logs: Log[] = [];
      try {
        logs = (await token.queryFilter(filter, fromBlock, scanTo)) as unknown as Log[];
      } catch (err) {
        logger.error(
          { err, fromBlock, scanTo, asset: asset.symbol },
          'queryFilter failed; will retry next pass',
        );
        return; // do NOT advance the cursor — retry the whole range next pass
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
        if (!depositAddresses.has(to.toLowerCase())) continue; // defensive
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

  // Re-run promotion for anything just discovered, then advance the cursor.
  await updateConfirmationsAndPromote(head);
  await query(
    `UPDATE chain_cursor SET last_scanned_block = $1 WHERE network = '${cfg.network}'`,
    [scanTo],
  );
  logger.debug({ fromBlock, scanTo, head }, 'reconciler pass complete');
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

  // Nothing to look for. Advance the cursor anyway so an idle period does not
  // build a backlog that has to be walked block by block when a payment appears.
  if (depositAddresses.size > 0) {
    try {
      await scanNativeTransfers(asset, fromBlock, scanTo);
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
 * Update confirmations = head - block_number for pending incoming txs and promote
 * their payments to `confirmed` at >= required_confirmations. Idempotent: the
 * promotion WHERE clause only fires once (status must still be 'confirming').
 */
async function updateConfirmationsAndPromote(head: number): Promise<void> {
  // Update confirmations on the tx rows. Scoped to BEP20: `head` is a BSC block
  // number and comparing it against a Tron block number is meaningless.
  await query(
    `UPDATE blockchain_transactions
        SET confirmations = GREATEST(0, $1 - block_number)
      WHERE direction = 'incoming'
        AND status = 'pending'
        AND network = '${cfg.network}'
        AND block_number IS NOT NULL`,
    [head],
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
        AND p.status = 'confirming'`,
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
  const ready = await query<{ id: string; tx_hash: string | null; fully_paid: boolean }>(
    `SELECT p.id, p.tx_hash, (p.amount_received >= p.amount) AS fully_paid
       FROM payments p
       JOIN blockchain_transactions bt ON bt.payment_id = p.id
      WHERE p.status = 'confirming'
        AND bt.direction = 'incoming'
        AND bt.status = 'pending'
        AND bt.network = '${cfg.network}'
        AND ($1 - bt.block_number) >= p.required_confirmations`,
    [head],
  );

  for (const p of ready) {
    // UNDERPAID. The transfer is final on-chain, but the customer owes more.
    // The payment goes to `partial` and stops here: no payment.confirmed, and
    // no sweep. It stays open, and recordIncoming already accepts `partial` in
    // its WHERE clause, so a top-up transfer to the same deposit address
    // re-enters this path and settles it properly once the balance is covered.
    if (!p.fully_paid) {
      const marked = await query<{ id: string; amount: string; amount_received: string }>(
        `UPDATE payments
            SET status = 'partial'
          WHERE id = $1 AND status = 'confirming'
          RETURNING id, amount, amount_received`,
        [p.id],
      );
      if (marked.length === 0) continue;

      // The transaction itself IS confirmed on-chain; only the payment is not
      // satisfied. Leaving the row `pending` would make the reconciler keep
      // re-counting confirmations against it forever.
      await query(
        `UPDATE blockchain_transactions
            SET status = 'confirmed'
          WHERE payment_id = $1 AND direction = 'incoming' AND status = 'pending'
            AND network = '${cfg.network}'`,
        [p.id],
      );

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

    // Promote confirming -> confirmed (guarded so it fires exactly once).
    const promoted = await query<{ id: string }>(
      `UPDATE payments
          SET status = 'confirmed', confirmed_at = now()
        WHERE id = $1 AND status = 'confirming'
        RETURNING id`,
      [p.id],
    );
    if (promoted.length === 0) continue; // already promoted by a concurrent pass

    // Mark the tx row confirmed too.
    await query(
      `UPDATE blockchain_transactions
          SET status = 'confirmed'
        WHERE payment_id = $1 AND direction = 'incoming' AND status = 'pending'
          AND network = '${cfg.network}'`,
      [p.id],
    );

    logger.info({ paymentId: p.id }, 'payment confirmed');

    // Side effects (idempotent enqueues): webhook + sweep.
    try {
      await enqueueWebhook({ paymentId: p.id, event: 'payment.confirmed' });
    } catch (err) {
      logger.error({ err, paymentId: p.id }, 'failed to enqueue confirmed webhook');
    }
    try {
      await sweepQueue.add(
        'sweep',
        { paymentId: p.id } as SweepJob,
        { jobId: `sweep-${p.id}` }, // dedupe by payment id (BullMQ forbids ':' in custom ids)
      );
    } catch (err) {
      logger.error({ err, paymentId: p.id }, 'failed to enqueue sweep job');
    }
  }
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
      enqueueWebhook({
        paymentId: c.payment_id,
        event: 'payment.reverted',
        overrides: { status: 'waiting', txHash: null },
      }).catch((err) =>
        logger.warn({ err, paymentId: c.payment_id }, 'reverted webhook enqueue failed'),
      );
    }
  }
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
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    reconcileOnce()
      .catch((err) => logger.error({ err }, 'reconciler pass failed'))
      .finally(() => {
        running = false;
      });
  }, RECONCILE_INTERVAL_MS);

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
    let nativeRunning = false;
    setInterval(() => {
      if (nativeRunning) return;
      nativeRunning = true;
      reconcileNativeOnce()
        .catch((err) => logger.error({ err }, 'native reconciler pass failed'))
        .finally(() => {
          nativeRunning = false;
        });
    }, RECONCILE_INTERVAL_MS);
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal, chain: cfg.label }, 'shutting down listener');
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
