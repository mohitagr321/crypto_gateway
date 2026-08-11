/**
 * Payout / settlement service.
 *
 * requestPayout: create a `pending` payout row (auto or manual) after computing the
 *   commission split against the client's active commission. Enqueues a payout job.
 * executePayout: consumed by the worker. Signs + broadcasts a transfer of the
 *   row's asset from the central wallet to the client's payout wallet, records
 *   tx_hash, transitions the payout row pending -> processing -> sent
 *   (-> confirmed by listener/worker).
 *
 * All money math is BigInt in base units.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE
 * -------------------------------------
 * 1. The AMOUNT is quantised to the SETTLEMENT ASSET, never to the ledger's
 *    18-dp accounting scale and never to a per-chain default. See toAssetAmount.
 * 2. `failed` means "we know this never reached the wire", and nothing else.
 *    A payout that threw after a broadcast was attempted is `unresolved` and
 *    keeps its reservation. See recordBroadcastFailure.
 */
import { Job } from 'bullmq';
import { formatUnits } from 'ethers';
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/pool';
import { logger } from '../config/logger';
import { AppError } from '../utils/apiError';
import { ACCOUNTING_DECIMALS, fromAccountingUnits, toAccountingUnits } from '../utils/money';
import { adapterFor, Network, parseNetwork } from '../blockchain/networks';
import { Asset, parseAsset } from '../blockchain/assets';
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

/**
 * Round a ledger amount DOWN to what the settlement asset can actually express,
 * and render it the way the adapter expects to be handed it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ledger works at a fixed 18-dp accounting scale (utils/money.ts) and the
 * columns are NUMERIC(38,18), which Postgres renders AT ITS DECLARED SCALE — a
 * net of 0.001 BTC comes back as the string '0.001000000000000000'. Every
 * adapter, meanwhile, parses `amountHuman` against the ASSET's own decimals: 8
 * for BTC, 6 for USDT on Tron and Ethereum, 18 for USDT on BSC. Handing the raw
 * column across that boundary broke two different ways:
 *
 *   * BTC rejected the string on its LENGTH, not its value — eighteen fractional
 *     characters is more than eight, so every single Bitcoin payout threw before
 *     anything was signed, forever, once a minute.
 *   * A percentage commission on a 6-dp gross produces genuine digits past the
 *     asset's precision (10.123456 at 1.5% nets 9.97160416), and parseUnits
 *     rejects those outright.
 *
 * Both looked like a formatting nit and were actually a total settlement outage
 * on three of the four chains, self-perpetuating because the settle tick recreates
 * whatever it fails to settle.
 *
 * WHY DOWN
 * --------
 * The remainder is money the merchant is owed but that the chain cannot carry.
 * Rounding it UP would pay out more than the balance guard reserved, which is an
 * overdraw of the central wallet; rounding it down and accounting for the
 * remainder as commission keeps `gross = commission + fee + net` exact and can
 * never send more than was held. The remainder is at most one indivisible unit
 * of the asset.
 *
 * The ASSET is the source of truth for this — never the network, and never a
 * global. BSC USDT is 18 dp and Tron USDT is 6, and the same symbol on the same
 * deployment must scale differently.
 */
interface AssetAmount {
  /** The floored value in the ASSET's base units. */
  units: bigint;
  /** The floored value back in ledger accounting units, for the DB columns. */
  ledgerUnits: bigint;
  /** What the adapter is handed: a human string with no more digits than exist. */
  human: string;
  /** What flooring discarded, in ledger accounting units. Never negative. */
  remainderUnits: bigint;
}

function toAssetAmount(amountHuman: string, asset: Asset): AssetAmount {
  // assets.ts validates this at boot; asserting it here too because the shift
  // below silently produces nonsense rather than throwing if it is ever false.
  if (asset.decimals < 0 || asset.decimals > ACCOUNTING_DECIMALS) {
    throw AppError.internal(
      `Asset ${asset.network} ${asset.symbol} declares ${asset.decimals} decimals, ` +
        `which the ${ACCOUNTING_DECIMALS}-dp accounting scale cannot represent`,
    );
  }
  const scale = 10n ** BigInt(ACCOUNTING_DECIMALS - asset.decimals);
  const amountUnits = toAccountingUnits(amountHuman);
  // Payout amounts are never negative (computeSplit clamps at 0 and the balance
  // guard rejects the rest), so BigInt's truncation toward zero IS a floor here.
  const units = amountUnits / scale;
  return {
    units,
    ledgerUnits: units * scale,
    human: formatUnits(units, asset.decimals),
    remainderUnits: amountUnits - units * scale,
  };
}

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

  // The settlement scope is passed to BOTH calls, and that is the whole point of
  // the denomination work — without it the guard is dead code.
  //
  // A commission of type `fixed` or `tiered` carries AMOUNTS: the flat value and
  // every tier bound. Those numbers have always meant USDT (that is what the
  // schema and this service both documented, and what migration 015 writes down)
  // but nothing told computeSplit what asset the settlement was in, so the number
  // was applied verbatim to whatever arrived. A `fixed 1` meaning one dollar took
  // one whole BITCOIN off a BTC settlement, and a 0.05 BTC payment fell into a
  // tier slab written as "0 – 10" meaning ten dollars.
  //
  // getActiveCommission treats the asset as a PREFERENCE, not a filter: a
  // mismatched row is still returned, ranked last, so a misconfigured client
  // fails loudly here rather than silently settling at zero commission.
  // computeSplit then refuses to apply it — there is no price oracle in this
  // gateway, and a thrown payout is recoverable by fixing the configuration
  // whereas a 100% fee that reads as legitimate commission is not.
  //
  // A throw here happens BEFORE withTransaction and before any INSERT, so
  // nothing is written: the payment stays `swept`, its funds stay in the central
  // wallet counted as the merchant's, and the settle tick re-drives it every
  // minute (logging `auto payout skipped` with this message) until an operator
  // gives the client a commission denominated in the asset they actually settle
  // in, or a percentage rate — which applies to any asset.
  const commission = await getActiveCommission(input.clientId, network, asset.symbol);
  const split = computeSplit(
    input.amount,
    commission,
    input.estimatedNetworkFee ?? '0',
    asset.symbol,
  );

  // Quantise the split to the SETTLEMENT ASSET before any of it is persisted.
  //
  // computeSplit works at the ledger's 18-dp scale, which is right for the
  // arithmetic and wrong for the wire: a percentage rate over a 6-dp gross
  // produces a net with more digits than Tron or Ethereum can express, and the
  // adapter throws when it tries to parse it. Doing this at creation means the
  // number the merchant is shown, the number the ledger reserves and the number
  // that goes on chain are all the same number.
  //
  // The discarded remainder is added to commission rather than dropped, so
  // gross = commission + fee + net still holds exactly and nothing goes missing
  // from the reconciliation. It is at most one indivisible unit of the asset.
  const net = toAssetAmount(split.netAmount, asset);
  const commissionAmount = fromAccountingUnits(
    toAccountingUnits(split.commissionAmount) + net.remainderUnits,
  );

  // Guard: nothing to pay after commission — do not create a zero/negative
  // payout. Checked AFTER quantising, because a net that is real at 18 dp but
  // rounds to zero in the asset (sub-satoshi dust on BTC) is equally unpayable,
  // and a zero-value transfer would burn a fee to move nothing.
  if (net.units <= 0n) {
    throw AppError.badRequest(
      `Net payout is zero after commission and ${asset.symbol} rounding ` +
        `(gross ${input.amount}, commission ${commissionAmount}, ` +
        `${asset.decimals} dp) — nothing to settle`,
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

    let res;
    try {
      res = await tx.query<PayoutRow>(
        `INSERT INTO payouts
           (client_id, payment_id, gross_amount, commission_amount, network_fee,
            net_amount, to_address, network, asset, status, type, triggered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)
         RETURNING *`,
        [
          input.clientId,
          input.paymentId ?? null,
          input.amount,
          commissionAmount,
          split.networkFee,
          fromAccountingUnits(net.ledgerUnits),
          toAddress,
          network,
          asset.symbol,
          input.type,
          input.triggeredByUserId ?? null,
        ],
      );
    } catch (err) {
      // uq_payouts_active_payment (migration 016): one live payout per payment.
      // The advisory lock above already serialises this path, so hitting it means
      // a payout for this payment exists that our own predicates think is dead —
      // an `unresolved` one whose transaction may be on chain. Refusing is the
      // whole point: creating a second row is how the merchant gets paid twice.
      // Reported as a conflict so the settle tick logs a sentence rather than
      // a 500, and an operator clicking Payout is told why.
      if ((err as { code?: string } | null)?.code === '23505') {
        throw AppError.conflict(
          `Payment ${input.paymentId} already has a payout that has not been ` +
            `resolved; settle or release that one before creating another`,
        );
      }
      throw err;
    }
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
          // The QUANTISED figures — the ones actually inserted above, and the
          // ones the chain will carry. Logging computeSplit's raw 18-dp output
          // here would leave the only immutable record of this payout disagreeing
          // with both the ledger row and the transfer, by the rounding remainder.
          net: fromAccountingUnits(net.ledgerUnits),
          commission: commissionAmount,
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
 * Worker processor: broadcast the transfer for a payout, in the row's own asset.
 *
 * Idempotency: only processes rows still in 'pending'/'failed'/'unresolved', plus
 * the narrow re-entrant slice of 'processing' described at the claiming UPDATE
 * below. Once a tx_hash is set and status advanced to 'sent'/'confirmed', re-runs
 * are skipped. An 'unresolved' row is re-entered on purpose — chainBroadcast's
 * happy retry path re-broadcasts the stored bytes, which is a no-op if the
 * original landed, and refuses outright where it cannot prove that.
 */
export async function executePayout(job: Job<PayoutJob>): Promise<void> {
  const { payoutId } = job.data;

  // A first, non-authoritative read. It only supplies the network/asset needed
  // to quantise the amount and to reject a no-op transfer BEFORE the row moves
  // out of 'pending'. Everything that decides whether we may sign or broadcast
  // is re-read from the claiming UPDATE below, never from this snapshot.
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
  // The asset recorded on the row, not a default: it decides both which token
  // moves and how many decimals the amount is allowed to carry.
  const asset = parseAsset(network, payout.asset);

  // Re-derive the wire amount from the ASSET rather than trusting the column's
  // rendering. `net_amount` is NUMERIC(38,18) and always comes back with
  // eighteen fractional digits, which BTC's parser rejects on length alone; and
  // rows created before payouts were quantised at request time may carry genuine
  // digits past what the chain can express. Both are settled here, once, before
  // anything is signed.
  const wire = toAssetAmount(payout.net_amount, asset);
  if (wire.units <= 0n) {
    // Deliberately thrown BEFORE the row moves to 'processing', and deliberately
    // not routed through recordBroadcastFailure: the row stays 'pending', which
    // is a reserved status, so the funds are neither released nor re-settled by
    // the tick. It sits in the admin payout list awaiting a human. Reaching here
    // means a payout was created that is worth less than one unit of its own
    // asset — impossible for new rows, which are guarded at request time.
    throw new Error(
      `payout ${payoutId} nets ${payout.net_amount} ${asset.symbol}, which rounds ` +
        `to zero at ${asset.decimals} dp — refusing to broadcast a no-op transfer`,
    );
  }

  // CLAIM THE ROW. This is a compare-and-set, not a blind write.
  //
  // The old code read the row on the pool, tested `status`, then issued an
  // UNCONDITIONAL `SET status='processing'` and built the chainBroadcast state
  // from that pre-lock snapshot. Everything between the read and
  // `persistPrepared` — including the up-to-45s chainLock acquire — was
  // therefore unguarded: a second executor for the same payoutId (a BullMQ
  // stalled-job redelivery after a Redis hiccup or a host pause) saw
  // signedTx=null, derived a FRESH nonce, and signed a genuinely different
  // second transfer. Both landed. The row's own state is the only authority on
  // whether we may sign, so it is read here, in the same statement that takes
  // ownership, and `state` below is built from THIS row.
  //
  // The claimable set:
  //   pending / failed / unresolved — nobody is executing this row. 'failed'
  //     means provably-never-broadcast (see recordBroadcastFailure) and
  //     'unresolved' is deliberately re-entered so chainBroadcast can
  //     re-broadcast stored bytes or refuse; both were already documented.
  //   processing WITH signed_tx or broadcast_at — a previous attempt got far
  //     enough that chainBroadcast can only take a SAFE branch: re-broadcast the
  //     identical bytes (same nonce on EVM, same txid on Bitcoin, a no-op if the
  //     original landed), or refuse to re-sign and escalate. Keeping this slice
  //     claimable is what stops a worker that crashed mid-broadcast from
  //     stranding the payout in 'processing' forever.
  //   processing with BOTH NULL is the one genuinely dangerous state — it is
  //     exactly the window where a second executor would pick a new nonce — and
  //     it is the one case excluded. Postgres re-evaluates this WHERE after
  //     taking the row lock under READ COMMITTED, so two concurrent claims
  //     cannot both succeed.
  //
  // Fold the discarded remainder into commission in the same statement, so a row
  // is never briefly recorded as paying more than it will send. The remainder is
  // derived from the row's OWN net_amount inside the UPDATE rather than from the
  // value this worker read a moment ago: Postgres evaluates every SET expression
  // against the pre-update row, so `net_amount - $2` IS the remainder — and it is
  // zero the second time, whatever else has happened in between. Passing a
  // pre-computed remainder instead would add it again on a retry that raced
  // another attempt, overstating commission and breaking
  // gross = commission + fee + net for a payout nobody would think to re-check.
  // (Quantising is idempotent, so $2 computed from an already-quantised
  // net_amount is the same number — a re-claim writes a zero-value adjustment.)
  const claimed = await queryOne<PayoutRow>(
    `UPDATE payouts
        SET status = 'processing',
            commission_amount = commission_amount + (net_amount - $2::numeric),
            net_amount = $2::numeric
      WHERE id = $1
        AND (
          status IN ('pending','failed','unresolved')
          OR (status = 'processing'
              AND (signed_tx IS NOT NULL OR broadcast_at IS NOT NULL))
        )
      RETURNING *`,
    [payoutId, fromAccountingUnits(wire.ledgerUnits)],
  );
  if (!claimed) {
    // Two ways to get here, both meaning "not ours to broadcast":
    //   (a) the row advanced to 'sent'/'confirmed' between the read above and
    //       this statement — already paid, nothing to do;
    //   (b) another executor is mid-sign on it (status 'processing', no signed
    //       bytes and no broadcast stamp yet).
    //
    // In both cases DO NOT touch the row. It keeps a status that RESERVES the
    // balance — 'processing' reserves exactly like 'sent' — so nothing is
    // released, and the settle tick cannot mint a second payout for the same
    // payment (its NOT EXISTS guard counts these statuses, and
    // uq_payouts_active_payment would reject it regardless). If the owner
    // finishes, it moves the row on itself; if it died inside that window, the
    // row surfaces in the admin payout list and in idx_payouts_needs_operator
    // (status IN ('unresolved','processing')) for a human. Never a released
    // reservation, never a second signer.
    //
    // (a) and (b) are NOT the same operational event, so they must not share a
    // log line. (a) is routine. (b) is a payout that NO automatic path will ever
    // move again: redrivePayouts excludes 'processing', markSettledPayments will
    // not mark it, and there is no admin route that resolves a payout row — so
    // the merchant's gross stays reserved until someone touches the database.
    // The settle tick's swept-backlog alarm only notices it if the payout has a
    // payment_id; a MANUAL payout stranded here has no other alarm at all, which
    // makes this line the only signal that exists. Re-read to tell them apart —
    // read-only, and a failure to read must not change the outcome.
    let stuck = false;
    try {
      const after = await queryOne<{
        status: string;
        signed_tx: string | null;
        broadcast_at: string | null;
      }>(
        `SELECT status, signed_tx, broadcast_at FROM payouts WHERE id = $1`,
        [payoutId],
      );
      stuck =
        after?.status === 'processing' &&
        after.signed_tx === null &&
        after.broadcast_at === null;
    } catch (err) {
      logger.warn({ err, payoutId }, 'could not re-read payout after a refused claim');
    }
    if (stuck) {
      // ERROR, not warn, for the same reason recordBroadcastFailure uses ERROR on
      // `unresolved`: this is a merchant's money held by a row that automation
      // has deliberately given up on. Nothing was broadcast in this state (both
      // signed_tx and broadcast_at are NULL, and each is written BEFORE anything
      // reaches the wire), so the funds are intact in the central wallet — the
      // payout simply needs a human to release it back to 'failed' or re-drive it.
      logger.error(
        { payoutId, paymentId: payout.payment_id, network: payout.network },
        'payout is `processing` with no signed transaction and no broadcast stamp — ' +
          'refusing to claim it, because a live executor in this state would sign a ' +
          'SECOND transfer with a fresh nonce. Nothing was broadcast, so no funds ' +
          'moved, but no automatic path will retry this row: if it stays this way ' +
          'the owning worker died and an operator must resolve it manually',
      );
    } else {
      logger.warn(
        { payoutId, seenStatus: payout.status },
        'payout not claimable (already advanced past our claim); ' +
          'skipping without broadcast — reservation retained',
      );
    }
    return;
  }
  if (wire.remainderUnits > 0n) {
    logger.warn(
      { payoutId, from: payout.net_amount, to: wire.human, asset: asset.symbol },
      'payout net rounded down to the asset precision; remainder booked as commission',
    );
  }

  let txHash: string;
  try {
    txHash = await broadcastTransferOnce({
      adapter,
      network,
      to: claimed.to_address,
      amountHuman: wire.human,
      // The asset recorded on the row, not a default: the amount was computed
      // against this asset's balance and must be sent in the same token.
      asset: claimed.asset,
      label: `payout ${claimed.id}`,
      // Built from the CLAIMED row. chainBroadcast branches on signedTx and
      // broadcastAt to decide between re-broadcasting stored bytes, refusing to
      // re-sign, and signing fresh — so feeding it a snapshot taken before we
      // owned the row is what let a redelivered job sign a second transfer.
      state: {
        nonce:
          claimed.nonce === null || claimed.nonce === undefined ? null : Number(claimed.nonce),
        signedTx: claimed.signed_tx ?? null,
        broadcastAt: claimed.broadcast_at ?? null,
        txHash: claimed.tx_hash ?? null,
      },
      markAttempted: async () => {
        await query(`UPDATE payouts SET broadcast_at = now() WHERE id = $1`, [claimed.id]);
      },
      persistPrepared: async (p) => {
        await query(
          `UPDATE payouts
              SET nonce = $2, signed_tx = $3, tx_hash = $4, broadcast_at = now()
            WHERE id = $1`,
          [claimed.id, p.nonce, p.signedTx, p.txHash],
        );
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'payout transfer failed';
    try {
      await recordBroadcastFailure(payoutId, msg);
    } catch (bookErr) {
      // The row keeps whatever status it had — 'processing', which reserves the
      // balance exactly like 'sent'. Nothing is released, so the worst case is a
      // payout an operator has to look at, never a duplicated one. Logged
      // separately so this never masks the failure that actually mattered.
      logger.error({ err: bookErr, payoutId }, 'could not record payout failure state');
    }
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

  if (claimed.payment_id) {
    enqueueWebhook({
      paymentId: claimed.payment_id,
      event: 'payout.completed',
      // The amount that went ON THE WIRE, not the column read before it was
      // quantised. `payout` was SELECTed above, so payout.net_amount is the
      // pre-flooring value; telling the merchant a net their own explorer will
      // not show is how a reconciliation dispute starts. Same number the ledger
      // now holds, rendered at the asset's precision.
      overrides: { txHash, status: 'swept', amount: wire.human },
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

/**
 * Book a failed broadcast — as `failed` ONLY if we know nothing reached the wire.
 *
 * `failed` is not a neutral label on a payout. It is a RELEASE: every predicate
 * that reserves a merchant's balance lists the live statuses and omits it, and
 * the settle tick treats a payment with no live payout as one that still needs
 * settling. So marking a payout failed says two things at once — "this did not
 * happen" and "that money is spendable again".
 *
 * The old code said both on ANY throw. But a throw out of the broadcast does not
 * mean nothing was sent: a socket reset after the node accepted the transaction
 * throws, and a Tron send whose response was lost throws. On those paths the
 * release dropped the gross out of `paidOut`, the settle tick created a SECOND
 * payout with a fresh nonce, and both landed. The per-row protections in
 * chainBroadcast could not help — they are keyed on THAT row's broadcast_at and
 * signed_tx, and a brand-new row has neither.
 *
 * `broadcast_at` is what tells the two apart. It is stamped before anything
 * reaches the wire — by markAttempted on chains that cannot pre-sign, by
 * persistPrepared on chains that can — so:
 *
 *   NULL     -> we know this never left. Release it; a fresh attempt is correct.
 *   NOT NULL -> we do not know. `unresolved`, which reserves exactly like `sent`.
 *
 * Unknown is deliberately treated as in-flight even where it is probably a
 * rejection (a node refusing for insufficient gas also stamps broadcast_at). The
 * asymmetry is the point: holding a reservation that turns out to be unnecessary
 * costs a merchant a delay and an operator five minutes on an explorer, while
 * releasing one that was needed sends someone else's money twice.
 *
 * `unresolved` is terminal for automation — only a human moves it on. It is
 * carried in both reservation sums below and shows in the admin payout list
 * verbatim (statusMap passes unknown statuses through).
 */
async function recordBroadcastFailure(payoutId: string, error: string): Promise<void> {
  // One statement, so the branch reads broadcast_at from the row it is updating
  // and cannot race the persistPrepared/markAttempted write it depends on.
  const row = await queryOne<{ status: string; broadcast_at: string | null }>(
    `UPDATE payouts
        SET status = CASE WHEN broadcast_at IS NULL
                          THEN 'failed'::payout_status
                          ELSE 'unresolved'::payout_status END,
            error = $2
      WHERE id = $1
      RETURNING status, broadcast_at`,
    [payoutId, error.slice(0, 1000)],
  );

  if (row?.status === 'unresolved') {
    // ERROR, not warn: this is money that may be on chain with nobody watching
    // it, and the reservation it holds keeps the merchant from settling that
    // balance until someone checks the explorer and resolves the row.
    logger.error(
      { payoutId, broadcastAt: row.broadcast_at, error },
      'payout failed AFTER a broadcast was attempted; held `unresolved` — ' +
        'check the explorer and settle it manually, funds stay reserved',
    );
  } else {
    logger.warn({ payoutId, error }, 'payout failed before broadcast; balance released');
  }
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
       -- Same reservation set as getBalanceWith below, including 'unresolved'
       -- (a payout that may already be on chain). The two must not drift: this
       -- one feeds the merchant's balance strip and that one feeds the guard
       -- that decides whether a payout may be created at all.
       SELECT network, asset, SUM(gross_amount) AS total
         FROM payouts
        WHERE client_id = $1
          AND status IN ('pending','processing','sent','confirmed','unresolved')
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
  // Two filter strings over the SAME positional arguments — one qualified for
  // the payments scan, one for the payouts subquery — so both tables can be
  // aggregated in a single statement without an unqualified `network` binding to
  // whichever scope happens to be innermost.
  const args: unknown[] = [clientId];
  let payFilter = '';
  let poFilter = '';
  if (network) {
    args.push(network);
    payFilter += ` AND p.network = $${args.length}`;
    poFilter += ` AND po.network = $${args.length}`;
  }
  if (asset) {
    args.push(asset);
    payFilter += ` AND p.asset = $${args.length}`;
    poFilter += ` AND po.asset = $${args.length}`;
  }

  // ONE ROUND TRIP, not three.
  //
  // requestPayout calls this while holding pg_advisory_xact_lock for
  // (client, network), on the transaction's own connection. Every millisecond
  // spent here is a millisecond that every other payout decision for this
  // merchant on this chain is queued behind, and the previous shape paid three
  // full client/server round trips plus three separate index scans for it. The
  // two payments aggregates are now one scan with FILTER — the status sets are
  // disjoint, so the numbers are identical — and the payouts reservation rides
  // along as a scalar subquery in the same statement.
  //
  // The status lists, the exclusions and the arithmetic are unchanged. This is
  // purely fewer round trips over the same rows; nothing is bounded away, so no
  // payment or payout can be dropped from either sum by this change.
  //
  // What still grows without bound is the ROW COUNT behind these sums — a
  // merchant's lifetime confirmed/swept history. Migration 022 adds covering
  // indexes (INCLUDE the summed columns) so this becomes an index-only scan with
  // no heap fetch, which is the part that actually hurt at volume. The permanent
  // answer is a materialised per-(client, network, asset) balance maintained by
  // whatever writes the underlying rows; that spans the listeners and is not
  // attempted here.
  //
  // NON-FUNGIBILITY IS PRESERVED EXACTLY: the filters are still applied per
  // (network, asset) and nothing is ever summed across a pair.
  //
  // 'failed' is the ONLY status that frees the funds, and it means something
  // narrow: we know the transfer never reached the wire. A payout that threw
  // after a broadcast was attempted is 'unresolved' and is counted here, because
  // it may be on chain — see recordBroadcastFailure. Releasing on "we don't
  // know" is what let the settle tick create a second payout for the same money.
  //
  // This list is duplicated in getAllBalances above and in the settle tick's
  // NOT EXISTS guard (workers/index.ts); all three describe the same set and any
  // status added here belongs in all of them.
  const rows = (await exec(
    `SELECT
       COALESCE(SUM(p.amount_received) FILTER (WHERE p.status IN ('confirmed','swept')),0)::text
         AS confirmed,
       COALESCE(SUM(p.amount) FILTER (WHERE p.status IN ('waiting','confirming','partial')),0)::text
         AS pending,
       COALESCE((SELECT SUM(po.gross_amount)
                   FROM payouts po
                  WHERE po.client_id = $1
                    AND po.status IN ('pending','processing','sent','confirmed','unresolved')
                    ${poFilter}), 0)::text
         AS paid_out
       FROM payments p
      WHERE p.client_id = $1
        AND p.status IN ('confirmed','swept','waiting','confirming','partial')
        ${payFilter}`,
    args,
  )) as Array<{ confirmed: string; pending: string; paid_out: string }>;

  // An ungrouped aggregate always returns exactly one row, even when the client
  // has no payments at all — the scalar subquery is still evaluated there, so a
  // merchant with payouts and no matching payments is not silently zeroed.
  const confirmed = rows[0]?.confirmed ?? '0';
  const pending = rows[0]?.pending ?? '0';
  const paidOut = rows[0]?.paid_out ?? '0';

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

