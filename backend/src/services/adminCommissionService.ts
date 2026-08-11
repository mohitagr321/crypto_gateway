/**
 * Admin commission accrual + withdrawal.
 *
 * The central wallet retains commission: every settled payout paid the client the
 * NET, keeping `commission_amount` in the central wallet. Admin's accrued balance
 * is therefore what was swept in, minus what is owed to clients, minus what has
 * already been withdrawn (including in-flight withdrawals).
 *
 * PER-NETWORK AND PER-ASSET — this is a correctness requirement, not a nicety.
 * Commission earned on TRC20 payments physically sits in the TRON central
 * wallet, and commission earned on BEP20 sits in the BSC one. The two are not
 * fungible and cannot be spent from each other. A single pooled figure would let
 * an admin withdraw Tron-earned commission from the BSC wallet, which either
 * fails on-chain or drains funds that were owed elsewhere. So every figure here
 * is scoped to one chain, and a withdrawal names the chain it settles on.
 *
 * That argument does not stop at the chain, and for a long time this file
 * stopped there anyway. USDC, BUSD, DAI and BNB commission on BSC all live in
 * the SAME central wallet as the USDT commission, but they are no more spendable
 * as USDT than Tron funds are spendable on BSC. The three sums below filtered on
 * `network` and not on `asset`, added every asset's accrual together, and
 * labelled the total USDT — and the withdrawal built on that number sent USDT,
 * so a BNB accrual was withdrawn out of merchants' USDT deposits. Every figure
 * here is therefore scoped to one (network, ASSET), and a withdrawal names both.
 */
import { Job } from 'bullmq';
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/pool';
import { logger } from '../config/logger';
import { AppError } from '../utils/apiError';
import { formatUnits } from 'ethers';
import {
  ACCOUNTING_DECIMALS,
  fromAccountingUnits,
  toAccountingUnits,
} from '../utils/money';
import {
  adapterFor,
  Network,
  parseNetwork,
  isNetwork,
} from '../blockchain/networks';
import { Asset, defaultAssetFor, enabledAssets, parseAsset } from '../blockchain/assets';
import { broadcastTransferOnce } from './chainBroadcast';
import { writeAudit } from './auditService';
import { adminWithdrawQueue, AdminWithdrawJob } from '../workers/queues';

export interface CommissionBalance {
  /** Which chain these figures pertain to. */
  network: Network;
  /** Which asset ON that chain. Never summed with any other. */
  asset: string;
  accrued: string; // commission pool physically held in this chain's central wallet
  withdrawn: string; // already withdrawn on this chain, including in-flight
  available: string; // accrued - withdrawn
  /**
   * Always equal to `asset`. Kept because the admin panel reads `currency`, and
   * it used to be the literal 'USDT' regardless of what the figure contained —
   * which is precisely the lie this scoping removes.
   */
  currency: string;
}

export interface AdminWithdrawalRow {
  id: string;
  amount: string;
  to_address: string;
  network: string;
  /** Asset withdrawn. Defaults to 'USDT' in the schema; always written now. */
  asset: string;
  tx_hash: string | null;
  /** Idempotent-broadcast bookkeeping — see services/chainBroadcast.ts. */
  nonce?: string | null;
  signed_tx?: string | null;
  broadcast_at?: string | null;
  status: string;
  triggered_by: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Admin's commission is REAL money physically retained in the central wallet:
 * only funds actually swept in, minus what is owed to / paid to clients, minus
 * what admin already withdrew. It is NOT derived from payout `commission_amount`
 * — that over-counts phantom commission from payouts whose funds never moved
 * (e.g. a zero-net payout, or before the deposit was ever swept).
 *
 *   collected  = confirmed on-chain sweeps into the central wallet
 *   clientOwed = net amounts reserved for clients (any active payout)
 *   accrued    = max(0, collected - clientOwed)            (commission pool)
 *   withdrawn  = admin withdrawals already in flight/done
 *   available  = max(0, accrued - withdrawn)               (withdrawable now)
 *
 * Every term is filtered to `network` AND `asset`, so the result describes
 * exactly the funds sitting in that chain's central wallet in that one token.
 * Arithmetic uses the network-independent accounting scale (utils/money.ts),
 * never a chain's on-chain decimals — the scale is a property of the ledger, and
 * mixing in a chain's decimals is how a 6-dp asset gets read as an 18-dp one.
 */
export async function getCommissionBalance(
  network: Network = 'BEP20',
  asset: string = defaultAssetFor(network),
): Promise<CommissionBalance> {
  const symbol = String(asset).toUpperCase();
  const collectedRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total
       FROM blockchain_transactions
      WHERE direction = 'sweep' AND status = 'confirmed'
        AND network = $1 AND asset = $2`,
    [network, symbol],
  );
  // `unresolved` belongs in this list, and leaving it out was a fund leak.
  //
  // A payout that threw AFTER its transaction reached the wire is now held as
  // `unresolved` rather than released as `failed` (see payoutService's
  // recordBroadcastFailure). Its net is money that is probably already on chain
  // to the merchant — so it is NOT operator commission. Omitting the status here
  // subtracts nothing from `collected`, which pushes the full net into `accrued`
  // and makes it withdrawable from the same central hot wallet the merchant was
  // just paid out of. The old `failed` leaked identically but for about sixty
  // seconds, until the settle tick re-minted the payout row; `unresolved` is
  // terminal for automation, so the leak would be permanent until a human
  // intervened. This is the same reservation set payoutService uses.
  //
  // The admin_withdrawals list below deliberately does NOT gain 'unresolved':
  // that table has its own lifecycle and nothing writes the status to it.
  const clientOwedRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(net_amount),0)::text AS total
       FROM payouts
      WHERE status IN ('pending','processing','sent','confirmed','unresolved')
        AND network = $1 AND asset = $2`,
    [network, symbol],
  );
  const withdrawnRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total
       FROM admin_withdrawals
      WHERE status IN ('pending','processing','sent','confirmed')
        AND network = $1 AND asset = $2`,
    [network, symbol],
  );

  const collectedU = toAccountingUnits(collectedRow?.total ?? '0');
  const clientOwedU = toAccountingUnits(clientOwedRow?.total ?? '0');
  const withdrawnU = toAccountingUnits(withdrawnRow?.total ?? '0');

  const accruedU = collectedU - clientOwedU;
  const accruedClamped = accruedU < 0n ? 0n : accruedU;
  const availU = accruedClamped - withdrawnU;

  return {
    network,
    asset: symbol,
    accrued: fromAccountingUnits(accruedClamped),
    withdrawn: fromAccountingUnits(withdrawnU),
    available: fromAccountingUnits(availU < 0n ? 0n : availU),
    currency: symbol,
  };
}

/** `${network}:${asset}` — the key every aggregate below is grouped by. */
function scopeKey(network: string, asset: string): string {
  return `${network}:${String(asset).toUpperCase()}`;
}

/**
 * Commission position on every (network, asset) this deployment holds, enabled
 * assets first and BEP20 USDT at the head — the panel's back-compat top-level
 * figure is taken from the first BEP20 entry.
 *
 * Two things this deliberately does NOT do:
 *
 *   It does not fan out one getCommissionBalance per asset. That was three
 *   queries per network; per ASSET it would be three per (network, asset), and
 *   this runs on every admin dashboard load. Three GROUP BY passes answer for
 *   every scope at once, and migration 015 adds the partial index the sweep
 *   aggregate needs.
 *
 *   It does not restrict the result to enabled assets. Turning an asset off in
 *   the registry does not move the coins out of the central wallet, and a
 *   balance that vanishes from the only screen that shows it is money nobody
 *   looks at. So the enabled set is UNIONed with every scope the ledger has
 *   actually seen; a disabled one still cannot be withdrawn (parseAsset rejects
 *   it below) but it stays visible and countable.
 */
export async function getAllCommissionBalances(): Promise<CommissionBalance[]> {
  const [collected, clientOwed, withdrawn] = await Promise.all([
    query<{ network: string; asset: string; total: string }>(
      `SELECT network, asset, COALESCE(SUM(amount),0)::text AS total
         FROM blockchain_transactions
        WHERE direction = 'sweep' AND status = 'confirmed'
        GROUP BY network, asset`,
    ),
    query<{ network: string; asset: string; total: string }>(
      // Same reservation set as getCommissionBalance above, `unresolved`
      // included — a payout whose transaction may already be on chain is money
      // owed to the merchant, never withdrawable operator commission. These two
      // lists must not drift.
      `SELECT network, asset, COALESCE(SUM(net_amount),0)::text AS total
         FROM payouts
        WHERE status IN ('pending','processing','sent','confirmed','unresolved')
        GROUP BY network, asset`,
    ),
    query<{ network: string; asset: string; total: string }>(
      `SELECT network, asset, COALESCE(SUM(amount),0)::text AS total
         FROM admin_withdrawals
        WHERE status IN ('pending','processing','sent','confirmed')
        GROUP BY network, asset`,
    ),
  ]);

  const sum = (rows: Array<{ network: string; asset: string; total: string }>) => {
    const m = new Map<string, bigint>();
    for (const r of rows) {
      m.set(scopeKey(r.network, r.asset), toAccountingUnits(r.total ?? '0'));
    }
    return m;
  };
  const collectedM = sum(collected);
  const owedM = sum(clientOwed);
  const withdrawnM = sum(withdrawn);

  // Enabled assets first, in registry order (BEP20 USDT leads), then anything
  // the ledger holds that the registry no longer lists.
  const scopes: Array<{ network: Network; asset: string }> = enabledAssets().map((a) => ({
    network: a.network,
    asset: a.symbol,
  }));
  const seen = new Set(scopes.map((s) => scopeKey(s.network, s.asset)));
  for (const key of [...collectedM.keys(), ...owedM.keys(), ...withdrawnM.keys()]) {
    if (seen.has(key)) continue;
    const [net, sym] = key.split(':');
    // A row whose network the code no longer recognises cannot be described as
    // a chain position at all; skip rather than fabricate a Network value.
    if (!isNetwork(net)) continue;
    seen.add(key);
    scopes.push({ network: net, asset: sym });
  }

  return scopes.map(({ network, asset }) => {
    const key = scopeKey(network, asset);
    const accruedU = (collectedM.get(key) ?? 0n) - (owedM.get(key) ?? 0n);
    const accrued = accruedU < 0n ? 0n : accruedU;
    const withdrawnU = withdrawnM.get(key) ?? 0n;
    const availU = accrued - withdrawnU;
    return {
      network,
      asset,
      accrued: fromAccountingUnits(accrued),
      withdrawn: fromAccountingUnits(withdrawnU),
      available: fromAccountingUnits(availU < 0n ? 0n : availU),
      currency: asset,
    };
  });
}

export interface RequestAdminWithdrawalInput {
  amount: string;
  toAddress: string;
  /** 'BEP20' (default) | 'TRC20'. Decides which central wallet pays. */
  network?: string;
  /**
   * Which token to withdraw from that wallet. Omitted -> the chain's default
   * (USDT everywhere it exists, BTC on Bitcoin), which is what every withdrawal
   * before this parameter existed silently was. Commission accrued in any other
   * asset can only be withdrawn by naming it here — it is NOT spendable as USDT.
   */
  asset?: string;
  triggeredByUserId: string;
  ip?: string | null;
}

/** Advisory-lock namespace for admin withdrawals; distinct from payouts'. */
/**
 * Quantise a human amount to what the SETTLEMENT ASSET can actually express.
 *
 * The ledger holds money at NUMERIC(38,18), so `100.00` comes back out of
 * Postgres as `100.000000000000000000` — eighteen fractional digits. Handing
 * that straight to an adapter is what broke every admin withdrawal outside
 * BEP20: btcToSats rejects anything past 8 dp outright, and parseUnits on a
 * 6-dp USDT (Tron, Ethereum) throws on the fractional overflow. BEP20 USDT is
 * 18 dp, which is the only reason this looked like it worked.
 *
 * payoutService does exactly this for merchant payouts; the admin path was left
 * on the raw column, so the two disagreed about what "an amount" is. Flooring
 * (never rounding) is deliberate and matches it: the discarded remainder is
 * sub-unit dust that stays in the central wallet and remains withdrawable, and
 * rounding UP would try to move commission that was never accrued.
 *
 * Decimals come from the asset — USDT is 18 on BSC and 6 on Tron and Ethereum —
 * never from a global and never from the network.
 */
function toWireAmount(amountHuman: string, asset: Asset): { ledger: string; human: string } {
  if (asset.decimals < 0 || asset.decimals > ACCOUNTING_DECIMALS) {
    throw AppError.internal(
      `Asset ${asset.network} ${asset.symbol} declares ${asset.decimals} decimals, ` +
        `which the ${ACCOUNTING_DECIMALS}-dp accounting scale cannot represent`,
    );
  }
  const scale = 10n ** BigInt(ACCOUNTING_DECIMALS - asset.decimals);
  // Withdrawal amounts are validated positive before this runs, so BigInt's
  // truncation toward zero is a floor.
  const units = toAccountingUnits(amountHuman) / scale;
  return { ledger: fromAccountingUnits(units * scale), human: formatUnits(units, asset.decimals) };
}

const ADMIN_WITHDRAW_LOCK_NAMESPACE = 8124;

export async function requestAdminWithdrawal(
  input: RequestAdminWithdrawalInput,
): Promise<AdminWithdrawalRow> {
  if (Number.isNaN(Number(input.amount)) || Number(input.amount) <= 0) {
    throw AppError.badRequest('amount must be a positive number');
  }

  // Resolve the chain first: adapterFor throws a 400 when the network is not
  // enabled, and its isValidAddress is what stops a 0x address being pasted into
  // a TRC20 withdrawal (or vice versa) and the funds going nowhere.
  const network: Network = parseNetwork(input.network);
  const adapter = adapterFor(network);
  // …and the asset, which decides which POOL is being drawn down. parseAsset
  // throws a 400 for an asset this chain does not settle rather than falling
  // back to USDT — a silent fallback here would spend the USDT pool to satisfy
  // a request for something else, which is the exact bug this scoping removes.
  const asset = parseAsset(network, input.asset);
  // Quantise BEFORE the balance guard and the INSERT, so the amount reserved,
  // the amount recorded and the amount that goes on the wire are one number.
  // Storing an unrepresentable value and discovering it at broadcast time is how
  // the row ended up `failed` after the pool had already been drawn down.
  const wire = toWireAmount(input.amount, asset);
  if (toAccountingUnits(wire.ledger) <= 0n) {
    throw AppError.badRequest(
      `Withdrawal ${input.amount} is smaller than one unit of ${asset.symbol} on ` +
        `${network} (${asset.decimals} decimals) and would send nothing`,
    );
  }
  if (!adapter.isValidAddress(input.toAddress)) {
    throw AppError.badRequest(
      `toAddress is not a valid ${network} address (expected ${
        network === 'TRC20' ? 'a base58 T… Tron' : 'an 0x… BEP20'
      } address)`,
    );
  }

  const row = await withTransaction(async (tx: PoolClient) => {
    // Serialise withdrawal decisions for this chain. Reading the available
    // commission and inserting the row that consumes it are two steps; two
    // admins clicking at once both passed the guard and together overdrew the
    // central wallet. The lock is transaction-scoped, so COMMIT or ROLLBACK
    // releases it and an error cannot leak it.
    //
    // The balance read below runs on the pool rather than on `tx`, which is
    // still correct: any competing writer is either waiting for this lock (so
    // it has not inserted yet) or committed before we acquired it (so its row
    // is visible to the read).
    //
    // Still keyed on the CHAIN alone, not on (chain, asset), even though the
    // balance it guards is now per-asset. Same reasoning as the payout lock: a
    // coarser lock only over-serialises two admins withdrawing different tokens
    // from the same wallet, which at admin volume is free, while narrowing it is
    // the change that could reintroduce the overdraw the lock exists to stop.
    await tx.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [
      ADMIN_WITHDRAW_LOCK_NAMESPACE,
      network,
    ]);

    // Guard against the commission available in THIS asset on THIS chain only.
    const balance = await getCommissionBalance(network, asset.symbol);
    if (toAccountingUnits(wire.ledger) > toAccountingUnits(balance.available)) {
      throw AppError.badRequest(
        `Withdrawal ${wire.human} ${asset.symbol} exceeds available ${network} ` +
          `${asset.symbol} commission ${balance.available} ${asset.symbol}`,
      );
    }

    const res = await tx.query<AdminWithdrawalRow>(
      `INSERT INTO admin_withdrawals (amount, to_address, network, asset, status, triggered_by)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [wire.ledger, input.toAddress, network, asset.symbol, input.triggeredByUserId],
    );
    const w = res.rows[0];
    await writeAudit(
      {
        actorUserId: input.triggeredByUserId,
        action: 'admin.commission_withdraw',
        entityType: 'admin_withdrawal',
        entityId: w.id,
        metadata: {
          amount: input.amount,
          toAddress: input.toAddress,
          network,
          asset: asset.symbol,
        },
        ip: input.ip ?? null,
      },
      tx,
    );
    return w;
  });

  await adminWithdrawQueue.add('execute', { withdrawalId: row.id } as AdminWithdrawJob);
  return row;
}

/** Worker processor: broadcast the admin commission withdrawal from the central wallet. */
export async function executeAdminWithdrawal(
  job: Job<AdminWithdrawJob>,
): Promise<void> {
  const { withdrawalId } = job.data;
  const w = await queryOne<AdminWithdrawalRow>(
    `SELECT * FROM admin_withdrawals WHERE id = $1`,
    [withdrawalId],
  );
  if (!w) {
    logger.warn({ withdrawalId }, 'executeAdminWithdrawal: row missing');
    return;
  }
  if (w.status === 'sent' || w.status === 'confirmed') {
    logger.info({ withdrawalId, status: w.status }, 'admin withdrawal already broadcast; skip');
    return;
  }

  // Dispatch to the withdrawal's own chain AND its own asset. The adapter signs
  // with that chain's central wallet — the same wallet the commission was
  // actually retained in — and enforces its own key check.
  //
  // The asset is resolved here, before anything is signed, for the same reason
  // the network is: an unrecognised symbol must fail this row loudly rather than
  // reach the adapter, where an absent asset falls back to the chain default and
  // moves USDT for a withdrawal the ledger recorded as BNB. A `failed` row is
  // safe — nothing left the wallet, and `failed` is excluded from the withdrawn
  // sum, so the commission simply becomes available again.
  let adapter;
  let assetSymbol: string;
  try {
    const network = parseNetwork(w.network);
    adapter = adapterFor(network);
    assetSymbol = parseAsset(network, w.asset).symbol;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'network or asset not available';
    await markFailed(withdrawalId, msg);
    throw err;
  }

  await query(
    `UPDATE admin_withdrawals SET status = 'processing', updated_at = now() WHERE id = $1`,
    [withdrawalId],
  );

  let txHash: string;
  try {
    txHash = await broadcastTransferOnce({
      adapter,
      network: parseNetwork(w.network),
      to: w.to_address,
      // Re-quantised from the stored column rather than passed through: the row
      // may predate the request-time flooring above, and NUMERIC(38,18) renders
      // 18 fractional digits regardless. This is the string the adapter parses.
      amountHuman: toWireAmount(w.amount, parseAsset(parseNetwork(w.network), w.asset)).human,
      // Threaded exactly as payoutService does. Without it chainBroadcast sends
      // the chain's default token, so a withdrawal booked against the BNB pool
      // moved USDT out of merchants' deposits instead.
      asset: assetSymbol,
      label: `admin withdrawal ${withdrawalId}`,
      state: {
        nonce: w.nonce === null || w.nonce === undefined ? null : Number(w.nonce),
        signedTx: w.signed_tx ?? null,
        broadcastAt: w.broadcast_at ?? null,
        txHash: w.tx_hash ?? null,
      },
      markAttempted: async () => {
        await query(
          `UPDATE admin_withdrawals SET broadcast_at = now(), updated_at = now() WHERE id = $1`,
          [withdrawalId],
        );
      },
      persistPrepared: async (p) => {
        await query(
          `UPDATE admin_withdrawals
              SET nonce = $2, signed_tx = $3, tx_hash = $4,
                  broadcast_at = now(), updated_at = now()
            WHERE id = $1`,
          [withdrawalId, p.nonce, p.signedTx, p.txHash],
        );
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'admin withdrawal transfer failed';
    await markFailed(withdrawalId, msg);
    throw err;
  }

  // ---- Past this line the transfer IS on the wire ---------------------------
  // Same rule as payouts: nothing below may route back into the retry path, or
  // a confirmation-wait timeout turns into a second withdrawal.
  await query(
    `UPDATE admin_withdrawals SET status = 'sent', tx_hash = $2, error = NULL, updated_at = now() WHERE id = $1`,
    [withdrawalId, txHash],
  );
  logger.info(
    { withdrawalId, txHash, network: w.network, asset: assetSymbol },
    'admin withdrawal broadcast',
  );

  try {
    if (await adapter.waitForTx(txHash)) {
      await query(
        `UPDATE admin_withdrawals SET status = 'confirmed', updated_at = now() WHERE id = $1`,
        [withdrawalId],
      );
    } else {
      logger.warn(
        { withdrawalId, txHash },
        'admin withdrawal did not confirm in time; left `sent` — verify on the explorer',
      );
    }
  } catch (err) {
    logger.warn({ err, withdrawalId, txHash }, 'withdrawal confirmation check failed; left `sent`');
  }
}

async function markFailed(id: string, error: string): Promise<void> {
  await query(
    `UPDATE admin_withdrawals SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [id, error.slice(0, 1000)],
  );
}

export async function listWithdrawals(limit = 50): Promise<AdminWithdrawalRow[]> {
  return query<AdminWithdrawalRow>(
    `SELECT * FROM admin_withdrawals ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
}
