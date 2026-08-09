/**
 * Bitcoin ChainAdapter.
 *
 * Loaded lazily by networks.ts and only when BTC_ENABLED=true, so a deployment
 * that does not settle Bitcoin never constructs any of this.
 *
 * ============================ THE UTXO DIFFERENCE ============================
 * Every other adapter here calls a transfer function on an account. This one
 * builds a transaction: it picks unspent outputs to consume, decides what new
 * outputs to create, and pays the difference as the fee. Three consequences run
 * through everything below.
 *
 * 1. THE FEE IS THE SIZE. There is no gas price to multiply by an opcode count
 *    — the fee is (vbytes x sat/vB), and vbytes depend on how many UTXOs are
 *    being consumed. A sweep of ten small deposits costs far more than a sweep
 *    of one large one, for the same value moved.
 *
 * 2. EVERY SWEEP IS A "NATIVE" SWEEP. There is no gas currency to fund an
 *    address with; the fee always comes out of what is being moved. The
 *    inverted flow that R5 introduced as a special case for BNB and TRX is the
 *    only flow that exists here.
 *
 * 3. THERE IS NO NONCE. Idempotence comes from re-broadcasting the EXACT signed
 *    bytes: identical bytes have an identical txid, so a second broadcast is a
 *    no-op the network deduplicates. Re-SIGNING is the dangerous operation — if
 *    the first transaction confirmed, its inputs are gone, selection picks
 *    different ones, and the result is a SECOND valid payment. That is why
 *    `preparePayout` refuses to run once a broadcast has been recorded; see the
 *    guard in services/chainBroadcast.ts.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { ChainAdapter, PayoutPreparation, SweepResult } from './networks';
import { assetFor } from './assets';
import {
  DUST_LIMIT_SATS,
  Utxo,
  addressBalanceSats,
  broadcastRawTx,
  btcNetwork,
  btcToSats,
  centralBtcAddress,
  deriveBtc,
  estimateVsize,
  feeRateSatPerVb,
  getTx,
  isBtcAddress,
  listUtxos,
  satsToBtc,
  signerFor,
  tipHeight,
} from './bitcoin';

const centralAddress = centralBtcAddress();

/** The single asset this chain settles. */
function btcAsset() {
  return assetFor('BTC', 'BTC');
}

/**
 * Build, sign and return a transaction spending `utxos` from one address.
 *
 * Every input belongs to a single p2wpkh address (a deposit address, or the
 * central wallet), so one key signs them all. `outputs` are exact satoshi
 * amounts; whatever is left over after them IS the fee, which is why the caller
 * computes amounts rather than a fee.
 */
function buildSignedTx(params: {
  utxos: Utxo[];
  fromIndex: number;
  outputs: Array<{ address: string; value: bigint }>;
}): { hex: string; txid: string; vsize: number } {
  const { utxos, fromIndex, outputs } = params;
  const key = deriveBtc(fromIndex);
  const network = btcNetwork();
  const payment = bitcoin.payments.p2wpkh({ pubkey: key.publicKey, network });
  if (!payment.output) throw new Error('could not build the p2wpkh script');

  const psbt = new bitcoin.Psbt({ network });
  for (const u of utxos) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      // Segwit inputs need only the output being spent, not the whole previous
      // transaction — which is why this needs no extra API round-trip per input.
      witnessUtxo: { script: payment.output, value: Number(u.value) },
    });
  }
  for (const o of outputs) {
    psbt.addOutput({ address: o.address, value: Number(o.value) });
  }

  const signer = signerFor(key);
  for (let i = 0; i < utxos.length; i++) psbt.signInput(i, signer);
  psbt.finalizeAllInputs();

  // `extractTransaction()` refuses (throws) when the implied fee rate is
  // absurd — by default above 5,000 sat/vB. That is deliberately NOT disabled:
  // it is a last-ditch guard against an arithmetic mistake in the callers
  // above, and the only cost of leaving it on is that a genuine 5,000 sat/vB
  // emergency would need a code change. Burning a balance as fee is the worse
  // failure by a wide margin.
  const tx = psbt.extractTransaction();
  return { hex: tx.toHex(), txid: tx.getId(), vsize: tx.virtualSize() };
}

/** Fee rate for this attempt, or null when it is too expensive to proceed. */
async function usableFeeRate(context: string): Promise<number | null> {
  const rate = await feeRateSatPerVb();
  if (rate > config.btc.maxFeeRate) {
    // DEFERRED, not failed — same reasoning as the Ethereum gas ceiling. The
    // funds are safe where they are and the settle tick retries; Bitcoin fee
    // spikes are usually hours, not days.
    logger.warn(
      { context, rate, ceiling: config.btc.maxFeeRate },
      'btc: fee rate above the ceiling; deferring. Funds are untouched and will ' +
        'be retried when fees fall.',
    );
    return null;
  }
  return rate;
}

export const bitcoinAdapter: ChainAdapter = {
  network: 'BTC',
  feeCurrency: 'BTC',
  requiredConfirmations: config.btc.requiredConfirmations,
  centralWalletAddress: centralAddress,
  // Bitcoin has no gas station and cannot have one: there is nothing to fund an
  // address WITH. Reported as unconfigured so the admin panel says so plainly
  // rather than showing a zero balance that looks like a problem.
  gasStationAddress: '',
  minSweepAmount: config.btc.minSweepAmount,

  isValidAddress(address: string): boolean {
    return isBtcAddress(address);
  },

  deriveDeposit(index: number) {
    const { address, path } = deriveBtc(index);
    return { address, path };
  },

  async balanceOf(address: string): Promise<string> {
    return satsToBtc(await addressBalanceSats(address));
  },

  /** Identical to balanceOf: on Bitcoin the native coin is the only asset. */
  async nativeBalanceOf(address: string): Promise<string> {
    return satsToBtc(await addressBalanceSats(address));
  },

  /**
   * BIP-21. Unlike the EVM URI this DOES carry the amount: BIP-21 is
   * near-universally supported by Bitcoin wallets and the amount is unambiguous
   * (always BTC, always 8 dp), so including it removes a step where the customer
   * could mistype.
   */
  paymentUri(address: string, amountHuman: string): string {
    const amount = Number(amountHuman);
    return Number.isFinite(amount) && amount > 0
      ? `bitcoin:${address}?amount=${satsToBtc(btcToSats(amountHuman)).replace(/0+$/, '').replace(/\.$/, '')}`
      : `bitcoin:${address}`;
  },

  /**
   * Sweep every confirmed UTXO at a deposit address to the central wallet.
   *
   * One output, no change: the whole point is to empty the address, so the
   * amount is (total inputs − fee) and nothing is left behind. Contrast the EVM
   * native sweep, which computes the same thing but from a single balance.
   *
   * RETRY SAFETY: the UTXO set is re-read every attempt. After a successful
   * sweep there are no confirmed UTXOs left, so a retry finds nothing and
   * returns null rather than sending anything.
   */
  async sweepDeposit({ paymentId, depositAddress, derivationIndex }): Promise<SweepResult | null> {
    const asset = btcAsset();
    const utxos = await listUtxos(depositAddress);
    if (utxos.length === 0) {
      logger.info({ paymentId, depositAddress }, 'btc sweep: no confirmed UTXOs; skipping');
      return null;
    }

    const total = utxos.reduce((acc, u) => acc + u.value, 0n);
    if (total < btcToSats(asset.minSweep)) {
      logger.info(
        { paymentId, balance: satsToBtc(total), network: 'BTC' },
        'btc sweep: balance below the asset minimum; skipping',
      );
      return null;
    }

    const rate = await usableFeeRate(`sweep ${paymentId}`);
    if (rate === null) return null;

    // Fee first, then the amount — the amount is what is LEFT. Doing it the
    // other way round is how a transaction ends up unable to pay for itself.
    const vsize = estimateVsize(utxos.length, 1);
    const fee = BigInt(Math.ceil(vsize * rate));
    if (total <= fee + DUST_LIMIT_SATS) {
      logger.warn(
        { paymentId, total: satsToBtc(total), fee: satsToBtc(fee), inputs: utxos.length },
        'btc sweep: fee would consume the balance; leaving it in place. ' +
          'Consolidating many tiny UTXOs costs more than one large one.',
      );
      return null;
    }

    const value = total - fee;
    const { hex, txid } = buildSignedTx({
      utxos,
      fromIndex: derivationIndex,
      outputs: [{ address: centralAddress, value }],
    });

    await broadcastRawTx(hex, txid);
    logger.info(
      {
        paymentId,
        txHash: txid,
        amount: satsToBtc(value),
        fee: satsToBtc(fee),
        inputs: utxos.length,
      },
      'btc sweep: broadcast to central, fee paid from the balance',
    );
    return { txHash: txid, amount: satsToBtc(value), asset: asset.symbol };
  },

  /**
   * One-shot payout. Present only to satisfy the interface — Bitcoin supports
   * prepare/broadcast, so `chainBroadcast` always takes that path instead, and
   * this exists so a caller that ignores the optional methods still works.
   */
  async sendPayout({ to, amountHuman }): Promise<{ txHash: string }> {
    const prepared = await bitcoinAdapter.preparePayout!({ to, amountHuman });
    return bitcoinAdapter.broadcastPayout!(prepared.signedTx);
  },

  /**
   * Select inputs, build the payout, sign it — without broadcasting.
   *
   * ============================ WHY SELECTION IS DETERMINISTIC ================
   * `listUtxos` returns a stably sorted list and selection walks it in order, so
   * re-running this over an UNCHANGED UTXO set produces byte-identical bytes and
   * the same txid. That makes an innocent retry (persist succeeded, broadcast
   * failed) safe.
   *
   * It does NOT make a retry safe once the first transaction has confirmed —
   * then the inputs are spent, selection picks others, and a second valid
   * payment is created. Nothing this function can do prevents that, because it
   * cannot see the earlier attempt. The protection is the caller's: it stores
   * the signed bytes BEFORE broadcasting and re-broadcasts them rather than
   * re-signing, and refuses to re-sign when a broadcast was already recorded.
   *
   * `nonce` is accepted and ignored — Bitcoin has none. The return value carries
   * 0 so the existing payout row shape does not need a Bitcoin special case.
   */
  async preparePayout({ to, amountHuman }): Promise<PayoutPreparation> {
    if (!isBtcAddress(to)) {
      throw new Error(
        `"${to}" is not a valid Bitcoin address for the configured network ` +
          `(${config.btc.isTestnet ? 'testnet' : 'mainnet'})`,
      );
    }
    const want = btcToSats(amountHuman);
    if (want < DUST_LIMIT_SATS) {
      throw new Error(
        `payout of ${amountHuman} BTC is below the dust limit ` +
          `(${satsToBtc(DUST_LIMIT_SATS)} BTC); the network would not relay it`,
      );
    }

    const rate = await feeRateSatPerVb();
    if (rate > config.btc.maxFeeRate) {
      throw new Error(
        `Bitcoin fee rate ${rate} sat/vB exceeds the ceiling ` +
          `(${config.btc.maxFeeRate}). Not signing a payout at this price.`,
      );
    }

    const available = await listUtxos(centralAddress);
    if (available.length === 0) {
      throw new Error('central Bitcoin wallet has no confirmed UTXOs to spend');
    }

    // Accumulate inputs in the list's deterministic order until they cover the
    // amount PLUS the fee that those very inputs imply — the fee grows with each
    // one added, so the target moves as we go.
    const selected: Utxo[] = [];
    let sum = 0n;
    let fee = 0n;
    let covered = false;
    for (const u of available) {
      selected.push(u);
      sum += u.value;
      // Two outputs (recipient + change) is the normal shape; if change turns
      // out to be dust the transaction gets smaller, never bigger, so costing
      // it at two is the safe direction.
      fee = BigInt(Math.ceil(estimateVsize(selected.length, 2) * rate));
      if (sum >= want + fee) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      throw new Error(
        `insufficient confirmed Bitcoin balance: have ${satsToBtc(sum)} BTC across ` +
          `${selected.length} UTXO(s), need ${satsToBtc(want + fee)} BTC ` +
          `(${amountHuman} plus ~${satsToBtc(fee)} fee)`,
      );
    }

    const outputs: Array<{ address: string; value: bigint }> = [
      { address: to, value: want },
    ];
    const change = sum - want - fee;
    if (change >= DUST_LIMIT_SATS) {
      outputs.push({ address: centralAddress, value: change });
    } else if (change > 0n) {
      // Dust change is ABANDONED TO THE FEE rather than created as an output.
      // An output below the dust limit is not relayed, so including it would
      // make the whole transaction unbroadcastable — and creating a UTXO that
      // costs more to spend than it holds is not a saving anyway.
      logger.info(
        { change: satsToBtc(change) },
        'btc payout: change is dust; adding it to the fee rather than creating ' +
          'an output the network would refuse to relay',
      );
    }

    const built = buildSignedTx({
      utxos: selected,
      fromIndex: config.btc.centralDerivationIndex,
      outputs,
    });
    logger.info(
      {
        to,
        amount: amountHuman,
        inputs: selected.length,
        fee: satsToBtc(fee),
        vsize: built.vsize,
        rate,
      },
      'btc payout prepared (not yet broadcast)',
    );

    return { nonce: 0, signedTx: built.hex, txHash: built.txid };
  },

  async broadcastPayout(signedTx: string): Promise<{ txHash: string }> {
    // The txid is a property of the signed bytes, so it is known before the
    // wire — which is what lets the caller record it first and send second.
    const txid = bitcoin.Transaction.fromHex(signedTx).getId();
    return { txHash: await broadcastRawTx(signedTx, txid) };
  },

  /**
   * Wait for one confirmation, bounded.
   *
   * Bitcoin blocks are ~10 minutes, so a "wait for confirmation" that actually
   * waited would hold a worker slot for a quarter of an hour. This checks for a
   * few minutes and then gives up WATCHING — which is not failing: the
   * transaction is on the network, the row keeps its txid, and the listener
   * picks up the confirmation whenever it lands.
   */
  async waitForTx(txHash: string): Promise<boolean> {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const tx = await getTx(txHash);
      if (tx?.status?.confirmed) return true;
      await new Promise((r) => setTimeout(r, 15_000));
    }
    logger.info(
      { txHash },
      'btc: not confirmed within the watch window (normal for ~10 minute blocks); ' +
        'the listener will record it when it lands',
    );
    return false;
  },
};

/** Current tip, for the listener and for health reporting. */
export { tipHeight };
