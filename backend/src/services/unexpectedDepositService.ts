/**
 * Wrong-asset deposit recovery.
 *
 * ============================== THE SITUATION ================================
 * A deposit address is derived per payment and expects ONE asset. Nothing on
 * chain stops a customer sending a different supported token to it — a USDC
 * transfer to a USDT payment's address is a perfectly valid transaction.
 *
 * Two wrong answers, for the record:
 *   - IGNORE it (what the listeners used to do). The funds are not lost, since
 *     the HD key is derivable, but they are invisible: the payment expires and
 *     nobody knows there is money sitting at that address.
 *   - CREDIT it to the payment. Far worse — it puts the wrong asset into a
 *     balance the merchant can withdraw, at 1:1, which is a real loss the moment
 *     the two assets are not the same price.
 *
 * The right answer is a separate ledger of arrivals that a human can act on,
 * which is what this is. A row here is NOT a balance and is never summed into
 * one.
 *
 * TWO CASES LAND HERE, and the UI distinguishes them by comparing `asset` with
 * `expected_asset`:
 *   - WRONG ASSET: they differ. A USDC transfer to a USDT invoice.
 *   - LATE PAYMENT: they match, but the payment had already expired or settled
 *     when the funds arrived. Equally stranded, equally recoverable, and just as
 *     invisible before this existed.
 *
 * ============================ CONVERSION IS OPT-IN ===========================
 * Recovery (sweeping the funds to the central wallet) is always safe and can be
 * automatic. CONVERSION is not: swapping someone's USDC into USDT realises a
 * price and a fee on their behalf. `clients.auto_convert_unexpected` defaults
 * FALSE and the merchant sets their own slippage ceiling.
 */
import { query, queryOne } from '../db/pool';
import { logger } from '../config/logger';
import { Network } from '../blockchain/networks';
import { Asset } from '../blockchain/assets';

export interface UnexpectedDepositRow {
  id: string;
  client_id: string;
  payment_id: string | null;
  network: string;
  asset: string;
  amount: string;
  expected_asset: string | null;
  deposit_address: string;
  derivation_index: string | null;
  tx_hash: string;
  log_index: number;
  status: string;
  sweep_tx_hash: string | null;
  converted_to: string | null;
  converted_amount: string | null;
  swap_tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Record a known asset arriving at a deposit address that expected a different
 * one. Called from BOTH listeners, on the path where they previously returned
 * early because the asset did not match.
 *
 * Idempotent: UNIQUE (tx_hash, log_index) means the WS fast path and the
 * polling reconciler seeing the same transfer produce one row, exactly as they
 * do for blockchain_transactions.
 *
 * Best-effort by design — it must never throw into the listener loop. A missed
 * record is recoverable (the funds are still at a derivable address); a crashed
 * listener stops crediting everyone's real payments.
 */
export async function recordUnexpectedDeposit(params: {
  network: Network;
  asset: Asset;
  amountHuman: string;
  depositAddress: string;
  txHash: string;
  logIndex?: number;
}): Promise<void> {
  const { network, asset, amountHuman, depositAddress, txHash } = params;
  const logIndex = params.logIndex ?? 0;

  // ======================= ONE ADDRESS, TWO EVM NETWORKS =====================
  // BEP20 and ERC20 share BIP-44 coin type 60 (see networks.ts), so HD index N
  // is the SAME address on both chains. That is what makes an Ethereum token
  // sent to a BSC deposit address recoverable at all — and it is also why an
  // exact `w.network = $2` match failed to resolve one: the wallets row was
  // minted under the network the payment was for, not the network the transfer
  // arrived on, so the lookup returned nothing and the function bailed without
  // writing a row. Nothing anywhere then recorded that the money existed.
  //
  // The ROW still records the network the transfer ACTUALLY arrived on, never
  // the wallet's minting network, so the merchant's recovery list and
  // `recover.ts --network=` agree about which chain to sweep on.
  const walletNetworks =
    network === 'BEP20' || network === 'ERC20' ? ['BEP20', 'ERC20'] : [network];

  try {
    // Resolve the address to a client. Only addresses WE derived are of
    // interest; a transfer to anything else is not ours to record.
    const owner = await queryOne<{
      client_id: string;
      derivation_index: string | null;
      payment_id: string | null;
      expected_asset: string | null;
    }>(
      `SELECT w.client_id,
              w.derivation_index,
              p.id    AS payment_id,
              p.asset AS expected_asset
         FROM wallets w
         LEFT JOIN LATERAL (
           SELECT id, asset FROM payments
            WHERE wallet_id = w.id
            ORDER BY created_at DESC LIMIT 1
         ) p ON true
        WHERE lower(w.address) = lower($1)
          AND w.type = 'deposit'
          AND w.network = ANY($2::text[])
        ORDER BY (w.network = $3) DESC
        LIMIT 1`,
      // The ORDER BY keeps the result deterministic when the widened match could
      // see two rows: an exact network match always wins over its coin-type-60
      // sibling.
      [depositAddress, walletNetworks, network],
    );
    if (!owner || !owner.client_id) return;

    await query(
      `INSERT INTO unexpected_deposits
         (client_id, payment_id, network, asset, amount, expected_asset,
          deposit_address, derivation_index, tx_hash, log_index, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'detected')
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [
        owner.client_id,
        owner.payment_id,
        network,
        asset.symbol,
        amountHuman,
        owner.expected_asset,
        depositAddress,
        owner.derivation_index,
        txHash,
        logIndex,
      ],
    );

    logger.warn(
      {
        network,
        asset: asset.symbol,
        expected: owner.expected_asset,
        amount: amountHuman,
        depositAddress,
        txHash,
      },
      'unexpected asset received at a deposit address — recorded for recovery, ' +
        'NOT credited to the payment',
    );
  } catch (err) {
    // Never let this break the listener. The funds remain recoverable from the
    // HD index regardless of whether this row was written.
    logger.error({ err, txHash }, 'failed to record unexpected deposit');
  }
}

export interface MerchantUnexpectedDeposit {
  id: string;
  network: string;
  asset: string;
  amount: string;
  expectedAsset: string | null;
  status: string;
  txHash: string;
  depositAddress: string;
  convertedTo: string | null;
  convertedAmount: string | null;
  error: string | null;
  createdAt: string;
}

function toMerchant(r: UnexpectedDepositRow): MerchantUnexpectedDeposit {
  return {
    id: r.id,
    network: r.network,
    asset: r.asset,
    amount: r.amount,
    expectedAsset: r.expected_asset,
    status: r.status,
    txHash: r.tx_hash,
    depositAddress: r.deposit_address,
    convertedTo: r.converted_to,
    convertedAmount: r.converted_amount,
    error: r.error,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listUnexpectedDeposits(
  clientId: string,
): Promise<MerchantUnexpectedDeposit[]> {
  const rows = await query<UnexpectedDepositRow>(
    `SELECT * FROM unexpected_deposits
      WHERE client_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [clientId],
  );
  return rows.map(toMerchant);
}

/** Count of rows still needing attention — drives the panel's nav badge. */
export async function countOpenUnexpected(clientId: string): Promise<number> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM unexpected_deposits
      WHERE client_id = $1 AND status NOT IN ('swept','converted')`,
    [clientId],
  );
  return Number(row?.n ?? 0);
}

/**
 * Claim a deposit for processing.
 *
 * The status transition is the lock: only a row still in `detected` can be moved
 * to `sweeping`, and the UPDATE returns nothing if another worker got there
 * first. That is what stops two workers sweeping the same address twice — which
 * on a chain means two transfers of the same funds, the second of which fails
 * noisily but only after burning gas.
 */
export async function claimForSweep(
  id: string,
  clientId: string,
): Promise<UnexpectedDepositRow | null> {
  return queryOne<UnexpectedDepositRow>(
    `UPDATE unexpected_deposits
        SET status = 'sweeping', error = NULL, updated_at = now()
      WHERE id = $1 AND client_id = $2 AND status IN ('detected','failed')
      RETURNING *`,
    [id, clientId],
  );
}

export async function markSwept(id: string, sweepTxHash: string): Promise<void> {
  await query(
    `UPDATE unexpected_deposits
        SET status = 'swept', sweep_tx_hash = $2, error = NULL, updated_at = now()
      WHERE id = $1`,
    [id, sweepTxHash],
  );
}

export async function markFailed(id: string, message: string): Promise<void> {
  await query(
    `UPDATE unexpected_deposits
        SET status = 'failed', error = $2, updated_at = now()
      WHERE id = $1`,
    [id, message.slice(0, 500)],
  );
}
