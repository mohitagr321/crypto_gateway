/**
 * ChainAdapter factory for EVM chains (BSC, Ethereum).
 *
 * Both chains run identical code and differ only in the values in
 * `evmChains.ts`. This file is the original BSC adapter with every hardcoded
 * `config.chain.*` / `config.centralWallet*` replaced by a field on the chain
 * config — the BSC behaviour is intended to be unchanged, and `bscAdapter.ts`
 * is now one line that instantiates this with `BSC`.
 *
 * ============================ TWO SWEEPS, OPPOSITE DIRECTIONS ================
 * A TOKEN sweep funds the deposit address with native currency from the gas
 * station, then moves the whole token balance.
 *
 * A NATIVE sweep cannot do that — the thing being moved IS the gas — so it pays
 * its own fee out of the balance and sends `balance − fee`. Same file, opposite
 * flow; see `sweepNativeDeposit` below.
 *
 * ============================ GAS POLICY IS THE REAL DIFFERENCE ==============
 * BSC tops up a fixed amount. Ethereum estimates per sweep and DEFERS when the
 * fee would exceed its ceiling — a sweep that costs more than it moves is not a
 * sweep worth making, and the funds are safe where they are until fees fall.
 */
import {
  JsonRpcProvider,
  Transaction,
  Wallet,
  formatEther,
  parseEther,
} from 'ethers';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { query } from '../db/pool';
import { deriveAddress, derivePrivateKey } from '../utils/hdwallet';
import { withChainLock } from '../utils/chainLock';
import { ChainAdapter, PayoutPreparation, SweepResult } from './networks';
import {
  fromBaseUnits,
  httpProviderFor,
  toBaseUnits,
  tokenContract,
  tokenWithSigner,
} from './usdt';
import { Asset, assetFor } from './assets';
import { EvmChainConfig } from './evmChains';

/**
 * How long to wait for a payout/sweep transaction to confirm before giving up on
 * WATCHING it. Giving up is not failing: the transaction stays on the chain and
 * the row keeps its hash, it just stops occupying a worker slot.
 */
const CONFIRM_TIMEOUT_MS = 120_000;

/** Gas a plain native value transfer costs. Fixed by the EVM, not estimated. */
const NATIVE_TRANSFER_GAS = 21_000n;

export function createEvmAdapter(cfg: EvmChainConfig): ChainAdapter {
  const provider = (): JsonRpcProvider => httpProviderFor(cfg.httpRpc, cfg.chainId);

  /**
   * Resolve a symbol to an asset on THIS chain. Omitted -> USDT, so every
   * pre-multi-asset call site keeps its exact previous behaviour. `assetFor`
   * throws a 400 for a symbol this deployment does not settle rather than
   * silently using USDT — moving the wrong token would be a fund-loss bug.
   */
  const chainAsset = (symbol?: string): Asset =>
    assetFor(cfg.network, symbol ?? 'USDT');

  /**
   * The address swept funds land in and payouts are signed from.
   *
   * DERIVED from the signing key wherever one exists, so the two can never
   * disagree — the mismatch bug where sweeps landed in one wallet while payouts
   * tried to spend from another. The configured address is only a fallback for a
   * read-only deployment with no key.
   */
  const centralWalletAddress = ((): string => {
    if (!cfg.centralWalletPrivateKey) return cfg.centralWalletAddress;
    try {
      const derived = new Wallet(cfg.centralWalletPrivateKey).address;
      if (
        cfg.centralWalletAddress &&
        derived.toLowerCase() !== cfg.centralWalletAddress.toLowerCase()
      ) {
        logger.warn(
          { chain: cfg.label, configured: cfg.centralWalletAddress, derived },
          'configured central wallet address does not match the central key; ' +
            "using the key's address so sweeps and payouts use the same wallet",
        );
      }
      return derived;
    } catch {
      logger.error(
        { chain: cfg.label },
        'central wallet private key is invalid; payouts/sweeps will fail until fixed',
      );
      return cfg.centralWalletAddress;
    }
  })();

  const gasStationAddress = ((): string => {
    if (!cfg.gasStationPrivateKey) return '';
    try {
      return new Wallet(cfg.gasStationPrivateKey).address;
    } catch {
      logger.error(
        { chain: cfg.label },
        'gas station private key is invalid; gas top-ups will fail',
      );
      return '';
    }
  })();

  /**
   * Native currency a deposit address needs to pay for one token transfer.
   *
   * Returns null when the sweep should be DEFERRED — only possible under the
   * dynamic policy, when the fee exceeds the configured ceiling. Deferring is
   * not failing: nothing is broadcast, the funds stay put, and the settle tick
   * re-drives the sweep on its next pass.
   */
  async function requiredGasTopup(
    rpc: JsonRpcProvider,
    asset: Asset,
    depositAddress: string,
  ): Promise<bigint | null> {
    if (cfg.gasPolicy.mode === 'fixed') {
      return parseEther(cfg.gasPolicy.topupAmount);
    }

    const policy = cfg.gasPolicy;
    const feeData = await rpc.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
    if (!gasPrice || gasPrice <= 0n) {
      throw new Error(`${cfg.label}: node returned no usable gas price`);
    }

    // Prefer the node's own estimate; fall back to a figure above the worst
    // realistic transfer when it cannot be reached.
    let gasUnits = policy.fallbackTransferGas;
    try {
      const estimate = await tokenContract(rpc, asset).transfer.estimateGas(
        centralWalletAddress,
        1n,
        { from: depositAddress },
      );
      if (estimate > 0n) gasUnits = estimate;
    } catch {
      // An estimate against an address holding no balance often reverts. That is
      // expected here, not an error — the fallback exists for exactly this.
      logger.debug(
        { chain: cfg.label, depositAddress },
        'gas estimate unavailable; using the fallback transfer gas',
      );
    }

    const fee = ((gasUnits * gasPrice) * BigInt(100 + policy.bufferPercent)) / 100n;
    const ceiling = parseEther(policy.maxFeeNative);
    if (fee > ceiling) {
      logger.warn(
        {
          chain: cfg.label,
          depositAddress,
          fee: formatEther(fee),
          ceiling: policy.maxFeeNative,
        },
        'sweep deferred: gas would exceed the ceiling. Funds are untouched and ' +
          'the settle tick will retry when fees fall.',
      );
      return null;
    }
    return fee;
  }

  /**
   * Sweep a NATIVE deposit (BNB / ETH) — the inverse of the token flow.
   *
   * ============================ THE FEE COMES OUT OF THE BALANCE ==============
   * A token sweep tops the deposit address up with gas and then moves the whole
   * token balance. That is impossible here: the thing being moved IS the gas.
   * Topping up would be circular, and moving the full balance would leave
   * nothing to pay the fee, so the transaction would simply be rejected.
   *
   * So the amount swept is `balance − fee`, and the fee is PINNED rather than
   * estimated: `gasLimit` is exactly 21,000 (the protocol constant for a value
   * transfer, not a guess) and `gasPrice` is read once, bumped, and written into
   * the transaction. Because both factors are fixed, the cost is EXACTLY
   * 21,000 × gasPrice, so `balance − fee` is affordable by construction.
   * Estimating the fee AFTER choosing the amount would let a gas-price tick make
   * the transaction unaffordable, and it would then fail forever.
   *
   * RETRY SAFETY: the amount is recomputed from the live balance every attempt,
   * so a retry sweeps what is actually there. After a successful sweep the
   * balance is below the floor and this returns null.
   */
  async function sweepNativeDeposit(params: {
    paymentId: string;
    depositAddress: string;
    derivationIndex: number;
    asset: Asset;
    rpc: JsonRpcProvider;
  }): Promise<SweepResult | null> {
    const { paymentId, depositAddress, derivationIndex, asset, rpc } = params;

    const balance = await rpc.getBalance(depositAddress);
    const balanceHuman = formatEther(balance);

    if (balance < parseEther(asset.minSweep)) {
      logger.info(
        { paymentId, balance: balanceHuman, asset: asset.symbol, network: cfg.network },
        'native sweep: balance below the asset minimum; skipping',
      );
      return null;
    }

    const feeData = await rpc.getFeeData();
    const baseGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (!baseGasPrice || baseGasPrice <= 0n) {
      throw new Error(`${cfg.label}: node returned no usable gas price`);
    }
    // Integer bump, applied in basis points so the arithmetic stays in BigInt
    // and never touches a float.
    const bumpBps = BigInt(Math.round(Number(config.assets.nativeSweepGasBump) * 10_000));
    const gasPrice = (baseGasPrice * bumpBps) / 10_000n;
    const fee = NATIVE_TRANSFER_GAS * gasPrice;

    if (balance <= fee) {
      logger.warn(
        { paymentId, balance: balanceHuman, fee: formatEther(fee) },
        'native sweep: fee would consume the entire balance; leaving it in place',
      );
      return null;
    }

    const value = balance - fee;
    const signer = new Wallet(derivePrivateKey(derivationIndex), rpc);
    const tx = await signer.sendTransaction({
      to: centralWalletAddress,
      value,
      // Both pinned, so the cost is exactly `fee` and cannot drift upward
      // between signing and mining.
      gasLimit: NATIVE_TRANSFER_GAS,
      gasPrice,
    });
    await tx.wait(1);

    const sweptHuman = formatEther(value);
    logger.info(
      {
        paymentId,
        chain: cfg.label,
        txHash: tx.hash,
        amount: sweptHuman,
        fee: formatEther(fee),
      },
      'native sweep: moved to central, fee paid from the balance',
    );
    return { txHash: tx.hash, amount: sweptHuman, asset: asset.symbol };
  }

  const adapter: ChainAdapter = {
    network: cfg.network,
    feeCurrency: cfg.feeCurrency,
    requiredConfirmations: cfg.requiredConfirmations,
    centralWalletAddress,
    gasStationAddress,
    minSweepAmount: cfg.minSweepAmount,

    isValidAddress(address: string): boolean {
      return /^0x[0-9a-fA-F]{40}$/.test(address);
    },

    deriveDeposit(index: number) {
      // Both EVM chains use BIP-44 coin type 60, so this is the SAME address on
      // BSC and Ethereum. Deposit indexes are never reused, so no two payments
      // collide — but it does mean a customer can pay on the wrong EVM chain,
      // and that those funds are recoverable because the key is the same.
      const derived = deriveAddress(index);
      return { address: derived.address, path: derived.path };
    },

    async balanceOf(address: string, symbol?: string): Promise<string> {
      const asset = chainAsset(symbol);
      // A native coin has no contract to call. Routing it through tokenContract
      // would build a contract at the empty address and read a meaningless zero
      // — the kind of silent wrong answer that ends in a payment never
      // confirming.
      if (asset.isNative) return formatEther(await provider().getBalance(address));
      const bal: bigint = await tokenContract(provider(), asset).balanceOf(address);
      return fromBaseUnits(bal, asset);
    },

    async nativeBalanceOf(address: string): Promise<string> {
      return formatEther(await provider().getBalance(address));
    },

    /**
     * EIP-681 URI. Amount is deliberately omitted to avoid decimal ambiguity
     * across wallets — the address is the load-bearing part.
     *
     * A native transfer is a PLAIN payment to the address, with no contract and
     * no `transfer` call. Emitting the token form for it would encode a call to
     * the empty string, which wallets either reject or render as a contract
     * interaction the customer cannot complete.
     */
    paymentUri(address: string, _amountHuman: string, symbol?: string): string {
      const asset = chainAsset(symbol);
      if (asset.isNative) return `ethereum:${address}@${cfg.chainId}`;
      return `ethereum:${asset.contract}@${cfg.chainId}/transfer?address=${address}`;
    },

    async sweepDeposit({
      paymentId,
      depositAddress,
      derivationIndex,
      asset: assetSymbol,
    }): Promise<SweepResult | null> {
      const asset = chainAsset(assetSymbol);
      const rpc = provider();

      if (asset.isNative) {
        return sweepNativeDeposit({
          paymentId,
          depositAddress,
          derivationIndex,
          asset,
          rpc,
        });
      }

      const tokenRead = tokenContract(rpc, asset);

      // On-chain balance is the source of truth (not amount_received).
      const balanceU: bigint = await tokenRead.balanceOf(depositAddress);
      const balanceHuman = fromBaseUnits(balanceU, asset);

      // The dust floor is the ASSET's, not the chain's: a chain-wide minimum
      // would be wrong the moment two assets have different decimals or value.
      if (balanceU < toBaseUnits(asset.minSweep, asset)) {
        logger.info(
          { paymentId, balance: balanceHuman, asset: asset.symbol, network: cfg.network },
          'sweep: balance below the asset minimum; skipping',
        );
        return null;
      }

      const depositSigner = new Wallet(derivePrivateKey(derivationIndex), rpc);

      // ---- Gas funding: the deposit address needs native currency to pay for
      //      its own transfer ----
      const nativeBalance = await rpc.getBalance(depositAddress);
      const topupWei = await requiredGasTopup(rpc, asset, depositAddress);
      if (topupWei === null) {
        // Dynamic policy said the fee is too high right now. Deferred, not
        // failed — returning null leaves the payment `confirmed` and the settle
        // tick re-enqueues the sweep next minute.
        return null;
      }

      if (nativeBalance < topupWei) {
        if (!cfg.gasStationPrivateKey) {
          logger.error(
            { paymentId, chain: cfg.label },
            'sweep: gas needed but no gas station key configured',
          );
          throw new Error('sweep requires gas funding but no gas station key configured');
        }
        // Serialised on the gas station key. The sweep worker runs at
        // concurrency 3, and all three top-ups are signed by this ONE wallet —
        // without the lock they read the same pending nonce and two of the three
        // are rejected, failing sweeps that had nothing wrong with them.
        //
        // Only the gas transfer is inside the lock. The token transfer below is
        // signed by the DEPOSIT address, which is unique per payment and
        // therefore has no contention at all.
        const fundTx = await withChainLock(cfg.network, 'gas', async () => {
          const gasSigner = new Wallet(cfg.gasStationPrivateKey, rpc);
          return gasSigner.sendTransaction({ to: depositAddress, value: topupWei });
        });
        await fundTx.wait(1);
        await query(
          `INSERT INTO blockchain_transactions
             (payment_id, direction, tx_hash, from_address, to_address, amount, token,
              network, status)
           VALUES ($1, 'gas_funding', $2, $3, $4, $5, $6, $7, 'confirmed')
           ON CONFLICT (tx_hash, log_index) DO NOTHING`,
          [
            paymentId,
            fundTx.hash,
            fundTx.from,
            depositAddress,
            formatEther(topupWei),
            cfg.feeCurrency,
            cfg.network,
          ],
        );
        logger.info(
          { paymentId, chain: cfg.label, txHash: fundTx.hash, amount: formatEther(topupWei) },
          'sweep: gas topped up',
        );
      }

      // ---- Transfer the full token balance to the central wallet ----
      const tx = await tokenWithSigner(depositSigner, asset).transfer(
        centralWalletAddress,
        balanceU,
      );
      await tx.wait(1);

      return { txHash: tx.hash, amount: balanceHuman, asset: asset.symbol };
    },

    async sendPayout({ to, amountHuman, asset: assetSymbol }): Promise<{ txHash: string }> {
      if (!cfg.centralWalletPrivateKey) {
        throw new Error('payout requires a funded central/hot wallet key');
      }
      const asset = chainAsset(assetSymbol);
      const signer = new Wallet(cfg.centralWalletPrivateKey, provider());
      // A native payout is a plain value transfer; the central wallet pays the
      // fee on top, exactly as it pays gas for a token transfer, so the merchant
      // receives the full amount.
      if (asset.isNative) {
        const tx = await signer.sendTransaction({ to, value: parseEther(amountHuman) });
        return { txHash: tx.hash };
      }
      const tx = await tokenWithSigner(signer, asset).transfer(
        to,
        toBaseUnits(amountHuman, asset),
      );
      return { txHash: tx.hash };
    },

    /**
     * Build and sign the transfer without sending it.
     *
     * Everything that makes the transaction unique — nonce, gas price, gas
     * limit, chain id — is resolved and baked in here, so the signed bytes (and
     * therefore the hash) are fixed before anything touches the network. That is
     * what lets the caller record the hash first and broadcast second.
     *
     * `nonce` is passed back on a retry. Re-signing with the same nonce produces
     * different bytes if fees moved, but the chain still mines at most one
     * transaction for that nonce, so the merchant cannot be paid twice.
     */
    async preparePayout({
      to,
      amountHuman,
      nonce,
      asset: assetSymbol,
    }): Promise<PayoutPreparation> {
      if (!cfg.centralWalletPrivateKey) {
        throw new Error('payout requires a funded central/hot wallet key');
      }
      const asset = chainAsset(assetSymbol);
      const rpc = provider();
      const signer = new Wallet(cfg.centralWalletPrivateKey, rpc);

      // 'pending' counts the account's queued transactions too, so consecutive
      // payouts get consecutive nonces rather than all reusing the mined one.
      const pinnedNonce =
        nonce ?? (await rpc.getTransactionCount(signer.address, 'pending'));

      // Native and token payouts differ only in what is populated. The nonce pin
      // — the part that actually prevents a double-pay — is identical for both.
      const populated = asset.isNative
        ? { to, value: parseEther(amountHuman) }
        : await tokenWithSigner(signer, asset).transfer.populateTransaction(
            to,
            toBaseUnits(amountHuman, asset),
          );
      const request = await signer.populateTransaction({
        ...populated,
        nonce: pinnedNonce,
      });
      const signedTx = await signer.signTransaction(request);

      return {
        nonce: pinnedNonce,
        signedTx,
        // The hash is a property of the signed bytes — no network call needed.
        txHash: Transaction.from(signedTx).hash as string,
      };
    },

    /**
     * Put prepared bytes on the wire.
     *
     * A retry re-broadcasting an already-accepted transaction is the NORMAL
     * path, not a fault, so the node's ways of saying "I already have this" all
     * resolve successfully. Treating them as errors is what previously sent the
     * job back through the retry loop and produced a second transfer.
     */
    async broadcastPayout(signedTx: string): Promise<{ txHash: string }> {
      const txHash = Transaction.from(signedTx).hash as string;
      try {
        const sent = await provider().broadcastTransaction(signedTx);
        return { txHash: sent.hash };
      } catch (err) {
        const message = (err as Error)?.message?.toLowerCase() ?? '';
        const alreadyOnChain =
          message.includes('already known') ||
          message.includes('already imported') ||
          message.includes('nonce too low') ||
          message.includes('duplicate') ||
          message.includes('known transaction');
        if (alreadyOnChain) {
          logger.info({ chain: cfg.label, txHash }, 'payout already broadcast; treating as sent');
          return { txHash };
        }
        throw err;
      }
    },

    /**
     * Bounded confirmation wait. An unbounded waitForTransaction would pin a
     * payout worker slot indefinitely on a stuck transaction; with concurrency 3
     * three of those stall the whole payout queue.
     */
    async waitForTx(txHash: string): Promise<boolean> {
      const receipt = await provider().waitForTransaction(txHash, 1, CONFIRM_TIMEOUT_MS);
      return receipt?.status === 1;
    },
  };

  return adapter;
}
