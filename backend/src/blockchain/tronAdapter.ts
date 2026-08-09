/**
 * TRC20 (Tron) ChainAdapter.
 *
 * Loaded lazily by networks.ts and ONLY when TRON_ENABLED=true, so `tronweb` is
 * never constructed on a BEP20-only deployment.
 *
 * Differences from the BEP20 adapter that matter:
 *  - 6-decimal USDT (see blockchain/tron.ts).
 *  - Base58 `T...` addresses; tronweb's isAddress rejects EVM `0x` addresses,
 *    which is what stops a merchant pasting a BEP20 wallet as a TRC20 payout.
 *  - Fees are energy/bandwidth, burned as TRX. There is no gas price to estimate;
 *    `feeLimit` is a hard ceiling on the burn.
 *  - No `.wait()` equivalent: a broadcast returns a txid immediately and the
 *    receipt must be polled (see waitForTx).
 */
import { config } from '../config/env';
import { logger } from '../config/logger';
import { query } from '../db/pool';
import { deriveTronAddress, deriveTronPrivateKey } from '../utils/tronHdwallet';
import { ChainAdapter, SweepResult } from './networks';
import { Asset, assetFor } from './assets';
import {
  feeLimitSun,
  fromTronBaseUnits,
  isTronAddress,
  sunToTrx,
  toBigInt,
  toTronBaseUnits,
  tronAddressFromKey,
  tronClient,
  trxToSun,
  TRC20_ABI,
  TRX_TRANSFER_BANDWIDTH_BYTES,
} from './tron';
import { withChainLock } from '../utils/chainLock';

// ---- Central wallet resolution (mirrors the BSC logic in config/env.ts) -----
// The signing key is the source of truth for WHERE swept TRC20 funds live:
// sweeps go to this address and payouts spend from it. Derive the address from
// the key so the two can never diverge.
function resolveCentralAddress(): string {
  const key = config.tron.centralWalletPrivateKey;
  if (!key) return config.tron.centralWalletAddress;
  try {
    const derived = tronAddressFromKey(key);
    if (
      config.tron.centralWalletAddress &&
      derived !== config.tron.centralWalletAddress
    ) {
      logger.warn(
        { configured: config.tron.centralWalletAddress, derived },
        '[tron] TRON_CENTRAL_WALLET_ADDRESS does not match the address of the Tron central ' +
          "key. Using the key's address so sweeps and payouts use the same wallet.",
      );
    }
    return derived;
  } catch {
    logger.error('[tron] TRON_CENTRAL_WALLET_PRIVATE_KEY is invalid; TRC20 payouts/sweeps will fail.');
    return config.tron.centralWalletAddress;
  }
}

const centralWalletAddress = resolveCentralAddress();

/** Address of the TRX gas station, or '' when no Tron gas key is configured. */
function resolveGasStationAddress(): string {
  if (!config.tron.gasStationPrivateKey) return '';
  try {
    return tronAddressFromKey(config.tron.gasStationPrivateKey);
  } catch {
    logger.error('[tron] TRON_GAS_STATION_PRIVATE_KEY is invalid; TRX top-ups will fail.');
    return '';
  }
}

const gasStationAddress = resolveGasStationAddress();

/**
 * Resolve a symbol to a TRC20 asset. Omitted -> USDT so every pre-multi-asset
 * call site is unchanged. Throws a 400 for a symbol this deployment does not
 * settle rather than falling back to USDT — moving the wrong token loses funds.
 */
function trc20Asset(symbol?: string): Asset {
  return assetFor('TRC20', symbol ?? 'USDT');
}

/** Read-only TRC20 contract handle for a given asset (default USDT). */
async function tokenRead(asset: Asset, privateKey?: string) {
  const tw = tronClient(privateKey);
  return tw.contract(TRC20_ABI as unknown as never[], asset.contract);
}

/**
 * Sweep a NATIVE (TRX) deposit — the inverse of the TRC20 flow.
 *
 * ============================ THE RESERVE IS MEASURED, NOT GUESSED ===========
 * A TRC20 sweep tops the deposit address up with TRX so it can burn energy. That
 * is circular here: the thing being moved IS the fee currency.
 *
 * But unlike BNB, a TRX transfer is usually FREE. Every Tron account has a daily
 * free bandwidth allowance (600 bytes), and a TransferContract transaction is
 * about 300 — so a deposit address that has done nothing else today can send its
 * whole balance at no cost.
 *
 * That is worth measuring rather than assuming. A flat reserve of "about a TRX,
 * to be safe" would be silently wrong in both directions: it strands that TRX at
 * EVERY deposit address forever (it is never swept, and the key exists only in
 * the HD tree), and it is still a guess when the account genuinely has no
 * allowance left. So this reads the account's actual remaining bandwidth and
 * reserves only when it falls short.
 *
 * TRON_NATIVE_SWEEP_RESERVE_TRX is the ceiling on that fallback, not the normal
 * case.
 *
 * RETRY SAFETY: the balance is re-read every attempt, so a retry moves what is
 * actually there; after a successful sweep the balance is below the floor and
 * this returns null.
 */
async function sweepNativeTrx(params: {
  paymentId: string;
  depositAddress: string;
  derivationIndex: number;
  asset: Asset;
}): Promise<SweepResult | null> {
  const { paymentId, depositAddress, derivationIndex, asset } = params;
  const readClient = tronClient();

  const balanceSun = toBigInt(await readClient.trx.getBalance(depositAddress));
  const balanceHuman = sunToTrx(balanceSun);

  if (balanceSun < toTronBaseUnits(asset.minSweep, asset.decimals)) {
    logger.info(
      { paymentId, balance: balanceHuman, asset: asset.symbol, network: 'TRC20' },
      'native sweep: balance below the asset minimum; skipping',
    );
    return null;
  }

  // ---- How much (if anything) must stay behind for bandwidth ----
  let reserveSun = 0n;
  try {
    const res = (await readClient.trx.getAccountResources(depositAddress)) as {
      freeNetLimit?: number;
      freeNetUsed?: number;
      NetLimit?: number;
      NetUsed?: number;
    };
    const freeLeft = (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0);
    const stakedLeft = (res.NetLimit ?? 0) - (res.NetUsed ?? 0);
    const available = Math.max(0, freeLeft) + Math.max(0, stakedLeft);
    if (available < TRX_TRANSFER_BANDWIDTH_BYTES) {
      reserveSun = trxToSun(config.tron.nativeSweepReserveTrx);
      logger.info(
        { paymentId, available, reserve: sunToTrx(reserveSun) },
        'native sweep: no free bandwidth left; reserving TRX to cover the burn',
      );
    }
  } catch (err) {
    // Reading resources is an optimisation, not a requirement. If it fails,
    // reserve the ceiling: leaving a little behind is recoverable, while a
    // transfer that cannot pay its bandwidth simply fails and retries forever.
    reserveSun = trxToSun(config.tron.nativeSweepReserveTrx);
    logger.warn(
      { err, paymentId },
      'native sweep: could not read account bandwidth; reserving the configured maximum',
    );
  }

  if (balanceSun <= reserveSun) {
    logger.warn(
      { paymentId, balance: balanceHuman, reserve: sunToTrx(reserveSun) },
      'native sweep: bandwidth reserve would consume the balance; leaving it in place',
    );
    return null;
  }

  const valueSun = balanceSun - reserveSun;
  const signClient = tronClient(deriveTronPrivateKey(derivationIndex));
  const sent = (await signClient.trx.sendTransaction(
    centralWalletAddress,
    Number(valueSun),
  )) as { txid?: string; transaction?: { txID?: string } };
  const txId = sent.txid ?? sent.transaction?.txID;
  if (!txId) throw new Error('native TRX sweep did not return a transaction id');

  const ok = await tronAdapter.waitForTx(txId);
  if (!ok) throw new Error(`native TRX sweep ${txId} did not confirm`);

  const sweptHuman = sunToTrx(valueSun);
  logger.info(
    { paymentId, txHash: txId, amount: sweptHuman, reserved: sunToTrx(reserveSun) },
    'native sweep: TRX moved to central',
  );
  return { txHash: txId, amount: sweptHuman, asset: asset.symbol };
}

export const tronAdapter: ChainAdapter = {
  network: 'TRC20',
  feeCurrency: 'TRX',
  requiredConfirmations: config.tron.requiredConfirmations,
  centralWalletAddress,
  gasStationAddress,
  minSweepAmount: config.tron.minSweepAmount,

  isValidAddress(address: string): boolean {
    return isTronAddress(address);
  },

  deriveDeposit(index: number) {
    const derived = deriveTronAddress(index);
    return { address: derived.address, path: derived.path };
  },

  async balanceOf(address: string, symbol?: string): Promise<string> {
    const asset = trc20Asset(symbol);
    // TRX has no contract. Building one at the empty address would throw, or
    // worse, read a meaningless zero — see the same guard on the BSC side.
    if (asset.isNative) {
      return sunToTrx(toBigInt(await tronClient().trx.getBalance(address)));
    }
    const contract = await tokenRead(asset);
    const raw = await contract.balanceOf(address).call();
    return fromTronBaseUnits(toBigInt(raw), asset.decimals);
  },

  /**
   * TRX balance, in TRX (the node reports sun). This is the number an operator
   * has to watch: with no staked energy a TRC20 transfer burns ~13-30 TRX, so a
   * drained gas wallet silently stalls every sweep and payout on this chain.
   */
  async nativeBalanceOf(address: string): Promise<string> {
    return sunToTrx(toBigInt(await tronClient().trx.getBalance(address)));
  },

  /**
   * Tron has no widely-honoured payment-URI standard comparable to EIP-681
   * (TronLink/Trust/OKX each differ). A bare base58 address is what every Tron
   * wallet reliably scans, so we encode exactly that — the amount is shown in
   * the UI next to the QR instead.
   */
  paymentUri(address: string): string {
    return address;
  },

  async sweepDeposit({
    paymentId,
    depositAddress,
    derivationIndex,
    asset: assetSymbol,
  }): Promise<SweepResult | null> {
    const asset = trc20Asset(assetSymbol);

    // Native TRX takes the inverted path — see sweepNativeTrx.
    if (asset.isNative) {
      return sweepNativeTrx({ paymentId, depositAddress, derivationIndex, asset });
    }

    const readContract = await tokenRead(asset);
    const balanceU = toBigInt(await readContract.balanceOf(depositAddress).call());
    const balanceHuman = fromTronBaseUnits(balanceU, asset.decimals);

    // Per-ASSET dust floor. A chain-wide minimum would be wrong the moment two
    // Tron assets differ in decimals (USDD is 18 dp, USDT and USDC are 6).
    if (balanceU < toTronBaseUnits(asset.minSweep, asset.decimals)) {
      logger.info(
        { paymentId, balance: balanceHuman, asset: asset.symbol, network: 'TRC20' },
        'sweep: balance below the asset minimum; skipping',
      );
      return null;
    }

    // ---- Fee funding: the deposit address burns TRX for energy/bandwidth ----
    const readClient = tronClient();
    const trxBalance = toBigInt(await readClient.trx.getBalance(depositAddress));
    const topupSun = trxToSun(config.tron.gasTopupTrx);
    if (trxBalance < topupSun) {
      if (!config.tron.gasStationPrivateKey) {
        logger.error({ paymentId }, 'sweep: TRX needed but TRON_GAS_STATION_PRIVATE_KEY unset');
        throw new Error('TRC20 sweep requires TRX funding but no Tron gas station key configured');
      }
      // Serialised on the Tron gas key. Tron has no nonce, but TronWeb signs
      // against a reference block and two concurrent sends from one key can
      // still collide or double-spend the same bandwidth/energy budget. The
      // sweep worker runs at concurrency 3, so this is a real path.
      const gasAddress = tronAddressFromKey(config.tron.gasStationPrivateKey);
      const fundTx = await withChainLock('TRC20', 'gas', async () => {
        const gasClient = tronClient(config.tron.gasStationPrivateKey);
        return gasClient.trx.sendTransaction(depositAddress, Number(topupSun));
      });
      const fundTxId = (fundTx as unknown as { txid?: string; transaction?: { txID?: string } })
        .txid ?? (fundTx as unknown as { transaction?: { txID?: string } }).transaction?.txID;
      if (!fundTxId) throw new Error('TRX top-up did not return a transaction id');

      // The top-up must be final before the sweep can spend it as fees.
      const funded = await tronAdapter.waitForTx(fundTxId);
      if (!funded) throw new Error(`TRX top-up ${fundTxId} did not succeed`);

      await query(
        `INSERT INTO blockchain_transactions
           (payment_id, direction, tx_hash, from_address, to_address, amount, token,
            network, status)
         VALUES ($1, 'gas_funding', $2, $3, $4, $5, 'TRX', 'TRC20', 'confirmed')
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [paymentId, fundTxId, gasAddress, depositAddress, sunToTrx(topupSun)],
      );
      logger.info({ paymentId, txHash: fundTxId }, 'sweep: TRX topped up');
    }

    // ---- Transfer the full USDT balance to the central wallet ----
    const depositKey = deriveTronPrivateKey(derivationIndex);
    const signClient = tronClient(depositKey);
    // MUST be the same asset the balance was read from — signing against the
    // chain's default contract would move USDT while claiming to sweep USDC.
    const signContract = await signClient.contract(
      TRC20_ABI as unknown as never[],
      asset.contract,
    );
    const txId: string = await signContract
      .transfer(centralWalletAddress, balanceU.toString())
      .send({ feeLimit: feeLimitSun(), callValue: 0 });

    const ok = await tronAdapter.waitForTx(txId);
    if (!ok) throw new Error(`TRC20 sweep ${txId} reverted or did not confirm`);

    return { txHash: txId, amount: balanceHuman, asset: asset.symbol };
  },

  async sendPayout({ to, amountHuman, asset: assetSymbol }): Promise<{ txHash: string }> {
    if (!config.tron.centralWalletPrivateKey) {
      throw new Error('TRC20 payout requires TRON_CENTRAL_WALLET_PRIVATE_KEY');
    }
    const asset = trc20Asset(assetSymbol);
    // A native payout is a plain TRX transfer — no contract, no feeLimit. The
    // central wallet pays its own bandwidth, exactly as it does for a token
    // transfer, so the merchant receives the full amount.
    if (asset.isNative) {
      const client = tronClient(config.tron.centralWalletPrivateKey);
      const sent = (await client.trx.sendTransaction(
        to,
        Number(trxToSun(amountHuman)),
      )) as { txid?: string; transaction?: { txID?: string } };
      const txId = sent.txid ?? sent.transaction?.txID;
      if (!txId) throw new Error('native TRX payout did not return a transaction id');
      return { txHash: txId };
    }
    const signClient = tronClient(config.tron.centralWalletPrivateKey);
    const contract = await signClient.contract(
      TRC20_ABI as unknown as never[],
      asset.contract,
    );
    const txId: string = await contract
      // Scaled by the ASSET's decimals: USDD is 18 dp while USDT/USDC are 6, so
      // using the chain default here would be off by a factor of 10^12.
      .transfer(to, toTronBaseUnits(amountHuman, asset.decimals).toString())
      .send({ feeLimit: feeLimitSun(), callValue: 0 });
    return { txHash: txId };
  },

  /**
   * Poll for a receipt. Tron gives no promise to await, and a broadcast txid is
   * not proof of execution — an out-of-energy transfer still returns a txid and
   * then fails on-chain. Treat "no receipt yet" as not-yet-final and keep polling
   * until the bounded timeout.
   */
  async waitForTx(txHash: string): Promise<boolean> {
    const client = tronClient();
    const deadline = Date.now() + 90_000; // ~30 Tron blocks
    while (Date.now() < deadline) {
      try {
        const info = (await client.trx.getTransactionInfo(txHash)) as {
          id?: string;
          blockNumber?: number;
          receipt?: { result?: string };
        };
        if (info && info.blockNumber) {
          // A plain TRX transfer has no receipt.result; presence of a block is success.
          const result = info.receipt?.result;
          return result === undefined || result === 'SUCCESS';
        }
      } catch (err) {
        logger.debug({ err, txHash }, 'tron: receipt poll failed; retrying');
      }
      await new Promise((r) => setTimeout(r, 3_000)); // ~1 Tron block
    }
    logger.warn({ txHash }, 'tron: timed out waiting for receipt');
    return false;
  },
};
