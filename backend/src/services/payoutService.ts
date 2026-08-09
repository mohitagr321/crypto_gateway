/**
 * Payout / settlement service.
 *
 * requestPayout: create a `pending` payout row (auto or manual) after computing the
 *   commission split against the client's active commission. Enqueues a payout job.
 * executePayout: consumed by the worker. Signs + broadcasts a USDT transfer from
 *   the central wallet to the client's payout wallet, records tx_hash, transitions
 *   the payout row pending -> processing -> sent (-> confirmed by listener/worker).
 *
 * All money math is BigInt in base units.
 */
import { Job } from 'bullmq';
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/pool';
import { logger } from '../config/logger';
import { AppError } from '../utils/apiError';
import { fromAccountingUnits, toAccountingUnits } from '../utils/money';
import { adapterFor, Network, parseNetwork } from '../blockchain/networks';
import { parseAsset } from '../blockchain/assets';
import { broadcastTransferOnce } from './chainBroadcast';
import { computeSplit, getActiveCommission } from './commissionService';
import { writeAudit } from './auditService';
import { enqueueWebhook } from './webhookService';
import { payoutQueue, PayoutJob } from '../workers/queues';

export interface PayoutRow {
  id: string;
  nonce?: string | null;
  signed_tx?: string | null;
  broadcast_at?: string | null;
  client_id: string;
  payment_id: string | null;
  gross_amount: string;
  commission_amount: string;
  network_fee: string;
  net_amount: string;
  to_address: string;
  network: string;
  asset: string;
  tx_hash: string | null;
  status: string;
  type: string;
  triggered_by: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Namespace for pg_advisory_xact_lock, keeping payout locks from colliding with
 * any other advisory lock this database might grow later.
 */
const PAYOUT_LOCK_NAMESPACE = 8123;

export interface RequestPayoutInput {
  clientId: string;
  amount: string; // gross amount to settle, in `asset`
  paymentId?: string | null;
  network?: string; // 'BEP20' (default) | 'TRC20'
  asset?: string;   // 'USDT' (default); must exist on `network`
  type: 'auto' | 'manual';
  triggeredByUserId?: string | null;
  estimatedNetworkFee?: string; // human USDT; default 0
  ip?: string | null;
}

/**
 * Create a payout request. Resolves the client's payout wallet FOR THAT NETWORK +
 * active commission, computes the split, inserts a pending payout, enqueues it.
 *
 * Per (network, ASSET) throughout: the balance guard, the destination wallet and
 * the eventual on-chain transfer all pertain to one asset on one chain. TRC20
 * funds can only be settled to a TRC20 wallet, and a USDC balance can never be
 * drawn on by a USDT payout — neither is fungible with the other.
 *
 * The destination ADDRESS is still per-network, not per-asset: one address on a
 * chain receives every token on that chain.
 */
export async function requestPayout(input: RequestPayoutInput): Promise<PayoutRow> {
  if (Number.isNaN(Number(input.amount)) || Number(input.amount) <= 0) {
    throw AppError.badRequest('amount must be a positive number');
  }

  const network: Network = parseNetwork(input.network);
  const adapter = adapterFor(network); // throws 400 if the network is disabled
  const asset = parseAsset(network, input.asset); // throws 400 if not available here

  const client = await queryOne<{
    payout_wallet: string | null;
    payout_wallet_trc20: string | null;
    payout_wallet_erc20: string | null;
    payout_wallet_btc: string | null;
    status: string;
  }>(
    `SELECT payout_wallet, payout_wallet_trc20, payout_wallet_erc20,
            payout_wallet_btc, status
       FROM clients WHERE id = $1`,
    [input.clientId],
  );
  if (!client) throw AppError.notFound('Client not found');
  if (client.status !== 'approved') {
    throw AppError.forbidden(`Client is ${client.status}, not approved`);
  }

  // Resolve the destination for this network.
  //
  // ERC20 gets its OWN column even though an Ethereum address has the same 0x
  // shape as a BSC one. Falling back to `payout_wallet` would settle Ethereum
  // funds to an address the merchant nominated for BSC and may not control or
  // want to use here — and because the two chains share addresses, that mistake
  // would look plausible right up until it wasn't.
  const toAddress =
    network === 'TRC20'
      ? client.payout_wallet_trc20
      : network === 'ERC20'
        ? client.payout_wallet_erc20
        : network === 'BTC'
          ? client.payout_wallet_btc
          : client.payout_wallet;
  if (!toAddress) {
    throw AppError.badRequest(
      network === 'TRC20'
        ? 'Client has no payout_wallet_trc20 configured (TRC20 settlement not enabled)'
        : network === 'ERC20'
          ? 'Client has no payout_wallet_erc20 configured (Ethereum settlement not enabled)'
          : network === 'BTC'
            ? 'Client has no payout_wallet_btc configured (Bitcoin settlement not enabled)'
            : 'Client has no payout_wallet configured',
    );
  }
  if (!adapter.isValidAddress(toAddress)) {
    throw AppError.badRequest(`Configured ${network} payout wallet is not a valid address`);
  }

  const commission = await getActiveCommission(input.clientId);
  const split = computeSplit(
    input.amount,
    commission,
    input.estimatedNetworkFee ?? '0',
  );

  // Guard: nothing to pay after commission — do not create a zero/negative payout.
  if (toAccountingUnits(split.netAmount) <= 0n) {
    throw AppError.badRequest(
      `Net payout is zero after commission (gross ${input.amount}, commission ${split.commissionAmount}) — nothing to settle`,
    );
  }

  const row = await withTransaction(async (tx: PoolClient) => {
    // Serialise every payout decision for this (client, network).
    //
    // The balance guard is read-then-write: it sums confirmed payments minus
    // outstanding payouts, and only afterwards inserts the row that makes this
    // payout outstanding. Run concurrently — an admin clicking Payout while the
    // settle tick auto-settles, or two sweeps completing together — both reads
    // saw the same balance and both inserts passed, overdrawing the client.
    //
    // A transaction-scoped advisory lock closes the window and is released by
    // COMMIT/ROLLBACK automatically, so an error cannot leak it. It is keyed per
    // (client, network) rather than globally: different clients, and the same
    // client on different chains, have independent balances and must not queue
    // behind each other.
    //
    // Deliberately NOT keyed on the asset, even though the balance it guards is
    // now per-asset. A coarser lock over-serialises — two payouts for different
    // assets on the same chain queue behind each other — which is harmless at
    // this volume. Narrowing it is the change that could reintroduce the very
    // overdraw this lock exists to prevent, for no throughput that matters.
    await tx.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [
      PAYOUT_LOCK_NAMESPACE,
      `${input.clientId}:${network}`,
    ]);

    // Read the balance INSIDE the lock and on the transaction's own connection,
    // so it reflects every payout committed before us.
    const balance = await getBalanceWith(
      (sql, args) => tx.query(sql, args).then((r) => r.rows),
      input.clientId,
      network,
      asset.symbol,
    );
    if (toAccountingUnits(input.amount) > toAccountingUnits(balance.available)) {
      throw AppError.badRequest(
        `Payout amount ${input.amount} exceeds available ${network} ${asset.symbol} ` +
          `balance ${balance.available} ${asset.symbol}`,
      );
    }

    const res = await tx.query<PayoutRow>(
      `INSERT INTO payouts
         (client_id, payment_id, gross_amount, commission_amount, network_fee,
          net_amount, to_address, network, asset, status, type, triggered_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)
       RETURNING *`,
      [
        input.clientId,
        input.paymentId ?? null,
        input.amount,
        split.commissionAmount,
        split.networkFee,
        split.netAmount,
        toAddress,
        network,
        asset.symbol,
        input.type,
        input.triggeredByUserId ?? null,
      ],
    );
    const payout = res.rows[0];

    await writeAudit(
      {
        actorUserId: input.triggeredByUserId ?? null,
        actorType: input.type === 'auto' ? 'system' : 'user',
        action: 'payout.request',
        entityType: 'payout',
        entityId: payout.id,
        metadata: {
          gross: input.amount,
          net: split.netAmount,
          commission: split.commissionAmount,
          network,
          type: input.type,
        },
        ip: input.ip ?? null,
      },
      tx,
    );
    return payout;
  });

  await payoutQueue.add('execute', { payoutId: row.id } as PayoutJob);
  return row;
}

/**
 * Worker processor: broadcast the USDT transfer for a payout.
 *
 * Idempotency: only processes rows still in 'pending'/'failed'. Once a tx_hash is
 * set and status advanced, re-runs are skipped.
 */
export async function executePayout(job: Job<PayoutJob>): Promise<void> {
  const { payoutId } = job.data;

  const payout = await queryOne<PayoutRow>(
    `SELECT * FROM payouts WHERE id = $1`,
    [payoutId],
  );
  if (!payout) {
    logger.warn({ payoutId }, 'executePayout: row missing');
    return;
  }
  if (payout.status === 'sent' || payout.status === 'confirmed') {
    logger.info({ payoutId, status: payout.status }, 'payout already broadcast; skip');
    return;
  }

  const network = parseNetwork(payout.network);
  const adapter = adapterFor(network);

  await query(`UPDATE payouts SET status = 'processing' WHERE id = $1`, [payoutId]);

  let txHash: string;
  try {
    txHash = await broadcastTransferOnce({
      adapter,
      network,
      to: payout.to_address,
      amountHuman: payout.net_amount,
      // The asset recorded on the row, not a default: the amount was computed
      // against this asset's balance and must be sent in the same token.
      asset: payout.asset,
      label: `payout ${payout.id}`,
      state: {
        nonce: payout.nonce === null || payout.nonce === undefined ? null : Number(payout.nonce),
        signedTx: payout.signed_tx ?? null,
        broadcastAt: payout.broadcast_at ?? null,
        txHash: payout.tx_hash ?? null,
      },
      markAttempted: async () => {
        await query(`UPDATE payouts SET broadcast_at = now() WHERE id = $1`, [payout.id]);
      },
      persistPrepared: async (p) => {
        await query(
          `UPDATE payouts
              SET nonce = $2, signed_tx = $3, tx_hash = $4, broadcast_at = now()
            WHERE id = $1`,
          [payout.id, p.nonce, p.signedTx, p.txHash],
        );
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'payout transfer failed';
    await markFailed(payoutId, msg);
    throw err; // let BullMQ retry per queue policy
  }

  // ---- Past this line the transfer IS on the wire ----------------------------
  // Nothing below may route back into the retry path. The original code ran the
  // confirmation wait inside the same try as the broadcast, so a wait timeout
  // marked an already-sent payout `failed` and BullMQ sent a second transfer.
  await query(
    `UPDATE payouts SET status = 'sent', tx_hash = $2, error = NULL WHERE id = $1`,
    [payoutId, txHash],
  );
  logger.info({ payoutId, txHash, network }, 'payout broadcast');

  if (payout.payment_id) {
    enqueueWebhook({
      paymentId: payout.payment_id,
      event: 'payout.completed',
      overrides: { txHash, status: 'swept', amount: payout.net_amount },
    }).catch((err) =>
      logger.warn({ err, payoutId }, 'payout.completed webhook enqueue failed'),
    );
  }

  // Best-effort confirmation. Bounded by the adapter, and every failure mode is
  // swallowed: the payout is already sent, so "we stopped watching" must never
  // become "we send it again".
  try {
    const ok = await adapter.waitForTx(txHash);
    if (ok) {
      await query(`UPDATE payouts SET status = 'confirmed' WHERE id = $1`, [payoutId]);
      logger.info({ payoutId, txHash }, 'payout confirmed');
    } else {
      logger.warn(
        { payoutId, txHash },
        'payout did not confirm in time; left `sent` — verify on the explorer',
      );
    }
  } catch (err) {
    logger.warn({ err, payoutId, txHash }, 'payout confirmation check failed; left `sent`');
  }
}

async function markFailed(payoutId: string, error: string): Promise<void> {
  await query(
    `UPDATE payouts SET status = 'failed', error = $2 WHERE id = $1`,
    [payoutId, error.slice(0, 1000)],
  );
}

/**
 * Compute a client's available/pending balance from confirmed-but-unpaid vs
 * in-flight payments. "available" = confirmed/swept payments minus already
 * requested/sent payouts; "pending" = amounts still confirming/waiting.
 *
 * NETWORK SCOPE:
 *   - Pass `network` to get the balance ON THAT CHAIN. The payout guard MUST use
 *     this form: BEP20 and TRC20 funds are not fungible, so an aggregate figure
 *     would let a merchant overdraw one chain against the other's balance.
 *   - Omit `network` for the aggregate across all chains (the /balance display).
 *     On a BEP20-only deployment every row is BEP20, so the omitted-network total
 *     equals the old behaviour exactly.
 *
 * Arithmetic uses the network-independent accounting scale (utils/money.ts), not
 * any chain's on-chain decimals — all DB amounts are already human USDT strings.
 */
export async function getBalance(
  clientId: string,
  network?: Network,
  asset?: string,
): Promise<{ available: string; pending: string; currency: string }> {
  return getBalanceWith(query, clientId, network, asset);
}

/**
 * Every non-zero balance this client holds, one row per (network, asset).
 *
 * Computed as one grouped pass rather than N calls to getBalance, so the panel's
 * balance strip is a single round trip. The per-asset numbers are identical
 * either way — same aggregates, same exclusions.
 */
export async function getAllBalances(
  clientId: string,
): Promise<Array<{ network: string; asset: string; available: string; pending: string }>> {
  const rows = await query<{
    network: string;
    asset: string;
    confirmed: string;
    pending: string;
    paid_out: string;
  }>(
    `WITH conf AS (
       SELECT network, asset, SUM(amount_received) AS total
         FROM payments
        WHERE client_id = $1 AND status IN ('confirmed','swept')
        GROUP BY network, asset
     ), pend AS (
       SELECT network, asset, SUM(amount) AS total
         FROM payments
        WHERE client_id = $1 AND status IN ('waiting','confirming','partial')
        GROUP BY network, asset
     ), po AS (
       SELECT network, asset, SUM(gross_amount) AS total
         FROM payouts
        WHERE client_id = $1 AND status IN ('pending','processing','sent','confirmed')
        GROUP BY network, asset
     )
     SELECT k.network, k.asset,
            COALESCE(conf.total,0)::text AS confirmed,
            COALESCE(pend.total,0)::text AS pending,
            COALESCE(po.total,0)::text   AS paid_out
       FROM (
         SELECT network, asset FROM conf
         UNION SELECT network, asset FROM pend
         UNION SELECT network, asset FROM po
       ) k
       LEFT JOIN conf ON conf.network = k.network AND conf.asset = k.asset
       LEFT JOIN pend ON pend.network = k.network AND pend.asset = k.asset
       LEFT JOIN po   ON po.network   = k.network AND po.asset   = k.asset
      ORDER BY k.network, k.asset`,
    [clientId],
  );

  return rows.map((r) => {
    const availU = toAccountingUnits(r.confirmed) - toAccountingUnits(r.paid_out);
    return {
      network: r.network,
      asset: r.asset,
      available: fromAccountingUnits(availU < 0n ? 0n : availU),
      pending: r.pending,
    };
  });
}

/**
 * The balance computation itself, parameterised by how to run a query.
 *
 * requestPayout needs to read this INSIDE its transaction (and inside the
 * advisory lock) so the guard sees every payout committed before it. Everyone
 * else reads it from the pool. Same SQL either way — the alternative, a second
 * copy of these aggregates, is how the two would drift apart.
 */
type QueryExec = (sql: string, args: unknown[]) => Promise<Record<string, unknown>[]>;

async function getBalanceWith(
  exec: QueryExec,
  clientId: string,
  network?: Network,
  asset?: string,
): Promise<{ available: string; pending: string; currency: string }> {
  // Filters are built positionally so the same SQL serves all four combinations
  // (neither / network / network+asset). Asset without a network is rejected:
  // "the USDT balance" across chains is not a meaningful number, because BEP20
  // and TRC20 funds are not fungible and could never be settled together.
  if (asset && !network) {
    throw AppError.badRequest('An asset balance must be scoped to a network');
  }
  const args: unknown[] = [clientId];
  let filter = '';
  if (network) {
    args.push(network);
    filter += ` AND network = $${args.length}`;
  }
  if (asset) {
    args.push(asset);
    filter += ` AND asset = $${args.length}`;
  }
  const netFilter = filter;

  const one = async (sql: string): Promise<string> => {
    const rows = (await exec(sql, args)) as Array<{ total: string }>;
    return rows[0]?.total ?? '0';
  };

  const confirmed = await one(
    `SELECT COALESCE(SUM(amount_received),0)::text AS total
       FROM payments
      WHERE client_id = $1 AND status IN ('confirmed','swept')${netFilter}`,
  );
  const pending = await one(
    `SELECT COALESCE(SUM(amount),0)::text AS total
       FROM payments
      WHERE client_id = $1 AND status IN ('waiting','confirming','partial')${netFilter}`,
  );
  // 'failed' is deliberately excluded: a failed payout freed its funds. But note
  // that a payout with broadcast_at set may have landed anyway, which is why
  // executePayout refuses to blind-retry those rather than relying on this sum.
  const paidOut = await one(
    `SELECT COALESCE(SUM(gross_amount),0)::text AS total
       FROM payouts
      WHERE client_id = $1 AND status IN ('pending','processing','sent','confirmed')${netFilter}`,
  );

  const availU = toAccountingUnits(confirmed) - toAccountingUnits(paidOut);
  return {
    available: fromAccountingUnits(availU < 0n ? 0n : availU),
    pending,
    // Reports the asset actually aggregated. Unscoped (no asset) sums are
    // legacy/back-compat only and are labelled USDT, which is what every
    // pre-multi-asset row is.
    currency: asset ?? 'USDT',
  };
}

