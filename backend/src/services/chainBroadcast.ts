/**
 * Broadcast an outbound transfer exactly once, however many times it is retried.
 *
 * Shared by merchant payouts and admin commission withdrawals. Both spend from
 * the same central hot wallet and both had the same defect, so they get one
 * implementation rather than two that can drift.
 *
 * THE PROBLEM
 * -----------
 * A thrown error from "send this transfer" does NOT mean nothing was sent. An
 * RPC connection dropped after the node accepted the transaction throws. A
 * confirmation wait that times out throws. The old code caught any throw, marked
 * the row `failed`, and let BullMQ retry — so on those two paths it signed and
 * sent a SECOND transfer, and the recipient was paid twice.
 *
 * THE FIX, IN LAYERS
 * ------------------
 *  1. Serialise signing per (chain, key) so concurrent workers stop colliding on
 *     the account nonce — the collision that made the retry path common.
 *  2. Pin the transfer to a nonce, sign it, and persist the signed bytes BEFORE
 *     broadcasting. A retry re-broadcasts those exact bytes; the node reports it
 *     already has that transaction and the adapter treats that as success.
 *  3. Even if the bytes were lost and the transfer were re-signed, the nonce is
 *     reused — and a chain mines at most one transaction per nonce.
 *  4. Stamp `broadcast_at` before sending. On a chain that cannot offer (2) and
 *     (3), that stamp is the signal to REFUSE an automatic retry and ask for a
 *     human, rather than gamble on a double payment.
 *
 * Layer 3 is the one that actually makes a double-pay impossible; the others
 * make it rare enough that layer 3 is never exercised.
 */
import { logger } from '../config/logger';
import { ChainAdapter, Network } from '../blockchain/networks';
import { withChainLock } from '../utils/chainLock';

export interface BroadcastState {
  /** Nonce already pinned for this transfer, if it has been prepared before. */
  nonce: number | null;
  /** Signed bytes already committed to, if any. */
  signedTx: string | null;
  /** Set once a broadcast has been ATTEMPTED — successfully or not. */
  broadcastAt: string | null;
  /** Hash recorded alongside signedTx, if any. */
  txHash: string | null;
}

export interface BroadcastRequest {
  adapter: ChainAdapter;
  network: Network;
  to: string;
  amountHuman: string;
  state: BroadcastState;
  /**
   * Persist the pinned transfer. MUST commit before this resolves: it is the
   * record that lets a retry re-broadcast instead of re-sending.
   */
  persistPrepared: (prepared: {
    nonce: number;
    signedTx: string;
    txHash: string;
  }) => Promise<void>;
  /** Stamp broadcast_at for chains that cannot prepare (no signed bytes to store). */
  markAttempted: () => Promise<void>;
  /** For log lines and the manual-intervention error, e.g. 'payout 9f2…'. */
  label: string;
  /**
   * Token to transfer. Omitted -> the chain's USDT, so callers that predate
   * multi-asset are unchanged. Always pass it for a real payout: the amount and
   * the asset must agree or the transfer moves the wrong token.
   */
  asset?: string;
}

export async function broadcastTransferOnce(req: BroadcastRequest): Promise<string> {
  const { adapter, network, to, amountHuman, state, label } = req;
  // Which token to move. Threaded through every branch below — omitting it on
  // any one path would send USDT for a payout the ledger recorded as USDC.
  const asset = req.asset;

  // ---- Chains without nonce semantics (Tron) --------------------------------
  // There is no way to make the send re-runnable, so the honest behaviour is to
  // attempt it at most once and escalate. A stuck payout that an operator has to
  // look at is a far better outcome than a silently duplicated one.
  if (!adapter.preparePayout || !adapter.broadcastPayout) {
    if (state.broadcastAt) {
      throw new Error(
        `refusing to re-send ${label}: a transfer was already broadcast at ` +
          `${state.broadcastAt} and ${network} cannot prove whether it landed. ` +
          `Check the explorer and settle it manually.`,
      );
    }
    return withChainLock(network, 'central', async () => {
      await req.markAttempted();
      const { txHash } = await adapter.sendPayout({ to, amountHuman, asset });
      return txHash;
    });
  }

  // ---- Chains that can sign before broadcasting (EVM, Bitcoin) -------------
  return withChainLock(network, 'central', async () => {
    if (state.signedTx) {
      // The happy retry path. Re-broadcasting IDENTICAL bytes is a no-op
      // everywhere: same nonce on an EVM chain, same txid on Bitcoin.
      logger.info({ label }, 'retry: re-broadcasting the stored transaction');
      const sent = await adapter.broadcastPayout!(state.signedTx);
      return sent.txHash || state.txHash || '';
    }

    // ---- A broadcast was recorded but the bytes were not --------------------
    // `persistPrepared` writes the signed bytes BEFORE anything reaches the
    // wire, so this combination should be unreachable. If it ever happens, it
    // means an attempt was made whose result we cannot inspect — and re-signing
    // from here is not safe to do blindly:
    //
    //   On an EVM chain the nonce would pin it, but `nonce` is written in the
    //   SAME statement as `signed_tx`, so if one is missing so is the other.
    //
    //   On Bitcoin there is no nonce at all. If the first transaction confirmed,
    //   its inputs are spent, selection picks different ones, and re-signing
    //   produces a SECOND VALID PAYMENT. Nothing downstream would catch it.
    //
    // So stop, and make a human look. A stuck payout is recoverable; a
    // duplicated one is somebody else's money.
    if (state.broadcastAt) {
      throw new Error(
        `refusing to re-sign ${label}: a broadcast was recorded at ` +
          `${state.broadcastAt} but no signed transaction was stored, so it is ` +
          `not knowable whether it landed. Re-signing could pay twice. Check the ` +
          `explorer for the destination address and settle it manually.`,
      );
    }

    const prepared = await adapter.preparePayout!({
      to,
      amountHuman,
      nonce: state.nonce,
      asset,
    });

    // Persist before the wire. If this write fails, nothing was sent; if the
    // broadcast fails, we still know exactly what was signed and can resend it.
    await req.persistPrepared(prepared);

    const sent = await adapter.broadcastPayout!(prepared.signedTx);
    return sent.txHash || prepared.txHash;
  });
}
