/**
 * Admin commission accrual + withdrawal.
 *
 * The central wallet retains commission: every settled payout paid the client the
 * NET, keeping `commission_amount` in the central wallet. Admin's accrued balance
 * is therefore what was swept in, minus what is owed to clients, minus what has
 * already been withdrawn (including in-flight withdrawals).
 *
 * PER-NETWORK — this is a correctness requirement, not a nicety.
 * Commission earned on TRC20 payments physically sits in the TRON central
 * wallet, and commission earned on BEP20 sits in the BSC one. The two are not
 * fungible and cannot be spent from each other. A single pooled figure would let
 * an admin withdraw Tron-earned commission from the BSC wallet, which either
 * fails on-chain or drains funds that were owed elsewhere. So every figure here
 * is scoped to one chain, and a withdrawal names the chain it settles on.
 */
import { Job } from 'bullmq';
import { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../db/pool';
import { logger } from '../config/logger';
import { AppError } from '../utils/apiError';
import { fromAccountingUnits, toAccountingUnits } from '../utils/money';
import {
  adapterFor,
  enabledNetworks,
  Network,
  parseNetwork,
} from '../blockchain/networks';
import { broadcastTransferOnce } from './chainBroadcast';
import { writeAudit } from './auditService';
import { adminWithdrawQueue, AdminWithdrawJob } from '../workers/queues';

export interface CommissionBalance {
  /** Which chain these figures pertain to. */
  network: Network;
  accrued: string; // commission pool physically held in this chain's central wallet
  withdrawn: string; // already withdrawn on this chain, including in-flight
  available: string; // accrued - withdrawn
  currency: 'USDT';
}

export interface AdminWithdrawalRow {
  id: string;
  amount: string;
  to_address: string;
  network: string;
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
 * Every term is filtered to `network`, so the result describes exactly the funds
 * sitting in THAT chain's central wallet. Arithmetic uses the network-independent
 * accounting scale (utils/money.ts), never a chain's on-chain decimals.
 */
export async function getCommissionBalance(
  network: Network = 'BEP20',
): Promise<CommissionBalance> {
  const collectedRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total
       FROM blockchain_transactions
      WHERE direction = 'sweep' AND status = 'confirmed' AND network = $1`,
    [network],
  );
  const clientOwedRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(net_amount),0)::text AS total
       FROM payouts
      WHERE status IN ('pending','processing','sent','confirmed') AND network = $1`,
    [network],
  );
  const withdrawnRow = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount),0)::text AS total
       FROM admin_withdrawals
      WHERE status IN ('pending','processing','sent','confirmed') AND network = $1`,
    [network],
  );

  const collectedU = toAccountingUnits(collectedRow?.total ?? '0');
  const clientOwedU = toAccountingUnits(clientOwedRow?.total ?? '0');
  const withdrawnU = toAccountingUnits(withdrawnRow?.total ?? '0');

  const accruedU = collectedU - clientOwedU;
  const accruedClamped = accruedU < 0n ? 0n : accruedU;
  const availU = accruedClamped - withdrawnU;

  return {
    network,
    accrued: fromAccountingUnits(accruedClamped),
    withdrawn: fromAccountingUnits(withdrawnU),
    available: fromAccountingUnits(availU < 0n ? 0n : availU),
    currency: 'USDT',
  };
}

/** Commission position on every ENABLED chain, BEP20 first. */
export async function getAllCommissionBalances(): Promise<CommissionBalance[]> {
  return Promise.all(enabledNetworks().map((n) => getCommissionBalance(n)));
}

export interface RequestAdminWithdrawalInput {
  amount: string;
  toAddress: string;
  /** 'BEP20' (default) | 'TRC20'. Decides which central wallet pays. */
  network?: string;
  triggeredByUserId: string;
  ip?: string | null;
}

/** Advisory-lock namespace for admin withdrawals; distinct from payouts'. */
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
    await tx.query(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [
      ADMIN_WITHDRAW_LOCK_NAMESPACE,
      network,
    ]);

    // Guard against the commission available ON THIS CHAIN only.
    const balance = await getCommissionBalance(network);
    if (toAccountingUnits(input.amount) > toAccountingUnits(balance.available)) {
      throw AppError.badRequest(
        `Withdrawal ${input.amount} exceeds available ${network} commission ${balance.available} USDT`,
      );
    }

    const res = await tx.query<AdminWithdrawalRow>(
      `INSERT INTO admin_withdrawals (amount, to_address, network, status, triggered_by)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING *`,
      [input.amount, input.toAddress, network, input.triggeredByUserId],
    );
    const w = res.rows[0];
    await writeAudit(
      {
        actorUserId: input.triggeredByUserId,
        action: 'admin.commission_withdraw',
        entityType: 'admin_withdrawal',
        entityId: w.id,
        metadata: { amount: input.amount, toAddress: input.toAddress, network },
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

  // Dispatch to the withdrawal's own chain. The adapter signs with that chain's
  // central wallet — the same wallet the commission was actually retained in —
  // and enforces its own key check.
  let adapter;
  try {
    adapter = adapterFor(parseNetwork(w.network));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'network not available';
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
      amountHuman: w.amount,
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
  logger.info({ withdrawalId, txHash, network: w.network }, 'admin withdrawal broadcast');

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
