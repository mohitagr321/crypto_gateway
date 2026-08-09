/**
 * Deposit-address fund recovery utility.
 *
 * Derives the private key for a given HD deposit index (the SAME derivation the
 * gateway uses), shows the on-chain USDT + native balance, and — if a
 * destination is given — sweeps the funds out.
 *
 * TWO MODES, because the fee flows in opposite directions:
 *   default    sweeps the TOKEN, funding the address with gas first if a gas key
 *              is available.
 *   --native   sweeps the chain's OWN coin (BNB / TRX). No funding step: the
 *              balance pays its own fee, so what lands is balance minus fee.
 *
 * The native mode exists because R5 made BNB and TRX payable assets, and because
 * the BEP20 listener cannot see BNB moved by a contract (no trace API on public
 * RPCs). Such a deposit is invisible to the gateway but NOT lost — this recovers
 * it by index.
 *
 * This exists for the case the automatic sweeper could not handle: a deposit
 * that confirmed but whose sweep kept failing (out of gas/energy, RPC outage, a
 * contract pause). It talks only to the chain, never to the gateway's queues, so
 * it is safe to run while the gateway is up.
 *
 * Run from backend/ (Node 20):
 *   ./node_modules/.bin/tsx src/recover.ts <index>
 *   ./node_modules/.bin/tsx src/recover.ts <index> <destination> [gasFunderPrivateKey]
 *   ./node_modules/.bin/tsx src/recover.ts --network=TRC20 <index> <T-destination>
 *   ./node_modules/.bin/tsx src/recover.ts --native <index> <destination>
 *
 * Read-only when no <destination> is passed. The HD index for a payment is
 * wallets.derivation_index (join payments.wallet_id).
 *
 * ============================ WHICH --network TO PASS ========================
 * `wallets.network` says which chain the index was MINTED on, and that is
 * usually the one you want. But the two questions are not the same:
 *
 *   BEP20 vs TRC20 — genuinely different addresses. They use different BIP-44
 *   coin types (60 vs 195), so index N on one has nothing to do with index N on
 *   the other, and looking at the wrong chain just reports an empty address.
 *
 *   BEP20 vs ERC20 — the SAME address. Both are coin type 60. So a customer who
 *   sent USDT-on-Ethereum to a BSC deposit address really does have funds at
 *   that address, on Ethereum, invisible to the BSC listener. Passing
 *   `--network=ERC20` with the SAME index reaches them, because it is the same
 *   key. That is the cross-chain mis-send case, and it is recoverable precisely
 *   because the address is shared.
 */
import { Wallet, parseEther, formatEther } from 'ethers';
import { deriveAddress, derivePrivateKey } from './utils/hdwallet';
import { httpProviderFor, tokenContract, fromBaseUnits } from './blockchain/usdt';
import { assetFor } from './blockchain/assets';
import { evmChain } from './blockchain/evmChains';
import { config } from './config/env';
import { isNetwork, Network } from './blockchain/networks';

interface Args {
  network: Network;
  index: number;
  destination?: string;
  gasFunderPk?: string;
  /** Recover the chain's OWN coin (BNB / TRX) rather than the token. */
  native: boolean;
}

function parseArgs(argv: string[]): Args {
  // Flags may appear anywhere; everything else is positional, so the original
  // BEP20 invocation (`recover.ts <index> <dest> [gasKey]`) is unchanged.
  let network: Network = 'BEP20';
  let native = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg === '--native') {
      native = true;
      continue;
    }
    const m = /^--network=(.+)$/.exec(arg);
    if (m) {
      const value = m[1].toUpperCase();
      if (!isNetwork(value)) {
        console.error(`Unknown --network=. Use BEP20, ERC20 or TRC20.`);
        process.exit(1);
      }
      network = value;
    } else {
      positional.push(arg);
    }
  }
  return {
    network,
    native,
    index: Number(positional[0]),
    destination: positional[1],
    gasFunderPk: positional[2],
  };
}

function usage(): never {
  console.error(
    'Usage: tsx src/recover.ts [--network=BEP20|ERC20|TRC20] [--native] <index> [destination] [gasFunderPrivateKey]\n' +
      '\n' +
      '  --native   recover the chain\'s own coin (BNB / TRX) instead of the token.\n' +
      '             No gas funding is involved: the balance pays its own fee, so the\n' +
      '             amount recovered is the balance minus that fee.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// EVM chains (BSC, Ethereum) — one implementation, parameterised by chain.
// ---------------------------------------------------------------------------
async function recoverEvm(args: Args): Promise<void> {
  const { index, destination } = args;

  // The chain to talk to. BSC and Ethereum share BIP-44 coin type 60, so the
  // SAME index derives the SAME address on both — which is exactly why this is
  // parameterised. A customer who paid USDT-on-Ethereum to a BEP20 deposit
  // address has funds sitting at that address ON ETHEREUM, invisible to the BSC
  // listener. `--network=ERC20 <sameIndex>` reaches them with the same key.
  const cfg = evmChain(args.network);
  if (!cfg) {
    console.error(`${args.network} is not an EVM chain.`);
    process.exit(1);
  }
  if (!cfg.httpRpc) {
    console.error(
      `No RPC configured for ${cfg.label}. Set its RPC env var (ETH_HTTP_RPC ` +
        `for Ethereum) and re-run.`,
    );
    process.exit(1);
  }

  const gasFunderPk = args.gasFunderPk || cfg.gasStationPrivateKey;

  const address = deriveAddress(index).address;
  const pk = derivePrivateKey(index);

  const provider = httpProviderFor(cfg.httpRpc, cfg.chainId);
  // The chain's USDT, scaled by ITS decimals — 6 on Ethereum, 18 on BSC. Using
  // one constant for both is the mistake this whole layer exists to prevent.
  const usdtAsset = assetFor(cfg.network, 'USDT');
  const usdtBal: bigint = await tokenContract(provider, usdtAsset).balanceOf(address);
  const nativeBal: bigint = await provider.getBalance(address);

  report({
    network: cfg.network,
    index,
    address,
    usdt: `${fromBaseUnits(usdtBal, usdtAsset)} USDT`,
    native: `${formatEther(nativeBal)} ${cfg.feeCurrency} (needed for gas)`,
    pk,
  });

  // ---- Native recovery (--native) ----------------------------------------
  // Since R5 the gateway accepts BNB itself, so a deposit address can hold a
  // NATIVE balance that is the payment rather than the gas for one. Sweeping it
  // is the inverse of the token path below: no funding step, because the
  // balance pays its own fee, and the amount is `balance − fee` rather than the
  // whole balance.
  if (args.native) {
    if (nativeBal === 0n) {
      console.log(`No ${cfg.feeCurrency} at this address — nothing to recover.`);
      return;
    }
    if (!destination) return readOnlyHint(index, cfg.network, '<yourWallet0x>', true);
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
      console.error(`Destination must be a 0x  address.`);
      process.exit(1);
    }

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (!gasPrice) {
      console.error('Could not read a gas price from the node.');
      process.exit(1);
    }
    const fee = 21_000n * gasPrice;
    if (nativeBal <= fee) {
      console.error(
        `Balance ${formatEther(nativeBal)} ${cfg.feeCurrency} does not cover the ` +
          `${formatEther(fee)} ${cfg.feeCurrency} ` +
          `transfer fee. Nothing can be recovered at the current gas price.`,
      );
      process.exit(1);
    }
    const value = nativeBal - fee;
    console.log(
      `Sweeping ${formatEther(value)} ${cfg.feeCurrency} -> ${destination} ` +
        `(fee ${formatEther(fee)}) ...`,
    );
    const tx = await new Wallet(pk, provider).sendTransaction({
      to: destination,
      value,
      gasLimit: 21_000n,
      gasPrice,
    });
    const receipt = await tx.wait(1);
    console.log(`Done. tx: ${tx.hash} (status ${receipt?.status})`);
    console.log(`   ${explorerBase(cfg.network)}/tx/${tx.hash}`);
    return;
  }

  if (usdtBal === 0n) {
    console.log('No USDT at this address — nothing to recover.');
    if (nativeBal > 0n) {
      console.log(
        `   ${formatEther(nativeBal)} ${cfg.feeCurrency} is here though — recover it with --native.`,
      );
    }
    return;
  }
  if (!destination) return readOnlyHint(index, cfg.network, '<yourWallet0x>');
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
    console.error(`Destination must be a 0x ${cfg.network} address.`);
    process.exit(1);
  }

  // Ensure the deposit address has native currency for gas. Estimated rather
  // than fixed, because a figure that is generous on BSC is nowhere near enough
  // on Ethereum — and one sized for Ethereum would waste BNB on every BSC run.
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasNeeded = (gasPrice * 90_000n * 125n) / 100n;
  if (nativeBal < gasNeeded) {
    if (!gasFunderPk) {
      console.error(
        `\nNot enough ${cfg.feeCurrency} for gas. Send ~${formatEther(gasNeeded)} ` +
          `${cfg.feeCurrency} to ${address}, then re-run.`,
      );
      process.exit(1);
    }
    console.log(`Funding ${formatEther(gasNeeded)} ${cfg.feeCurrency} from the gas key...`);
    const funder = new Wallet(gasFunderPk, provider);
    const fundTx = await funder.sendTransaction({ to: address, value: gasNeeded });
    await fundTx.wait(1);
    console.log(`  gas funded: ${fundTx.hash}`);
  }

  const token = tokenContract(provider, usdtAsset).connect(
    new Wallet(pk, provider),
  ) as unknown as { transfer(to: string, value: bigint): Promise<{ hash: string; wait(n: number): Promise<{ status?: number | null } | null> }> };
  console.log(`Sweeping ${fromBaseUnits(usdtBal, usdtAsset)} USDT -> ${destination} ...`);
  const tx = await token.transfer(destination, usdtBal);
  const receipt = await tx.wait(1);
  console.log(`Done. tx: ${tx.hash} (status ${receipt?.status})`);
  console.log(`   ${explorerBase(cfg.network)}/tx/${tx.hash}`);
}

/** Block explorer for an EVM chain — a BSC hash on Etherscan is a dead link. */
function explorerBase(network: Network): string {
  return network === 'ERC20' ? 'https://etherscan.io' : 'https://bscscan.com';
}

// ---------------------------------------------------------------------------
// TRC20 (Tron)
//
// Required imports are deferred so this file still runs on a BEP20-only
// deployment where tronweb config is absent.
// ---------------------------------------------------------------------------
async function recoverTrc20(args: Args): Promise<void> {
  const { index, destination } = args;

  if (!config.tron.enabled) {
    console.error(
      'TRON_ENABLED is false. Set it to true (with the Tron config) before recovering TRC20 funds.',
    );
    process.exit(1);
  }

  /* eslint-disable @typescript-eslint/no-var-requires, global-require */
  const {
    feeLimitSun,
    fromTronBaseUnits,
    isTronAddress,
    sunToTrx,
    toBigInt,
    tronClient,
    trxToSun,
    TRC20_ABI,
  } = require('./blockchain/tron') as typeof import('./blockchain/tron');
  const { deriveTronAddress, deriveTronPrivateKey } =
    require('./utils/tronHdwallet') as typeof import('./utils/tronHdwallet');
  /* eslint-enable @typescript-eslint/no-var-requires, global-require */

  const gasFunderPk = args.gasFunderPk || config.tron.gasStationPrivateKey;

  const address = deriveTronAddress(index).address;
  const pk = deriveTronPrivateKey(index);

  const readClient = tronClient();
  const readContract = await readClient.contract(
    TRC20_ABI as unknown as never[],
    config.tron.usdtContract,
  );
  const usdtBal = toBigInt(await readContract.balanceOf(address).call());
  const trxBal = toBigInt(await readClient.trx.getBalance(address));

  report({
    network: 'TRC20',
    index,
    address,
    usdt: `${fromTronBaseUnits(usdtBal)} USDT`,
    native: `${sunToTrx(trxBal)} TRX (burned as energy/bandwidth)`,
    pk,
  });

  // ---- Native recovery (--native) ----------------------------------------
  // Same inversion as the BEP20 path: the balance pays its own bandwidth, so
  // there is no funding step. A reserve is only needed when the account has
  // exhausted its free daily allowance — see the adapter for the full reasoning.
  if (args.native) {
    if (trxBal === 0n) {
      console.log('No TRX at this address — nothing to recover.');
      return;
    }
    if (!destination) return readOnlyHint(index, 'TRC20', '<yourWalletT...>', true);
    if (!isTronAddress(destination)) {
      console.error('Destination must be a base58 T… Tron address (not a 0x address).');
      process.exit(1);
    }

    let reserve = 0n;
    try {
      const res = (await readClient.trx.getAccountResources(address)) as {
        freeNetLimit?: number;
        freeNetUsed?: number;
        NetLimit?: number;
        NetUsed?: number;
      };
      const available =
        Math.max(0, (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0)) +
        Math.max(0, (res.NetLimit ?? 0) - (res.NetUsed ?? 0));
      if (available < 300) reserve = trxToSun(config.tron.nativeSweepReserveTrx);
    } catch {
      reserve = trxToSun(config.tron.nativeSweepReserveTrx);
    }
    if (trxBal <= reserve) {
      console.error(
        `Balance ${sunToTrx(trxBal)} TRX does not exceed the ${sunToTrx(reserve)} TRX ` +
          `bandwidth reserve. Nothing can be recovered right now.`,
      );
      process.exit(1);
    }
    const value = trxBal - reserve;
    console.log(`Sweeping ${sunToTrx(value)} TRX -> ${destination} ...`);
    const sent = (await tronClient(pk).trx.sendTransaction(
      destination,
      Number(value),
    )) as { txid?: string; transaction?: { txID?: string } };
    const txId = sent.txid ?? sent.transaction?.txID;
    if (!txId) {
      console.error('Native TRX transfer did not return a transaction id.');
      process.exit(1);
    }
    console.log(`Broadcast. tx: ${txId}`);
    console.log(`   https://tronscan.org/#/transaction/${txId}`);
    await waitForTron(tronClient(), txId);
    return;
  }

  if (usdtBal === 0n) {
    console.log('No USDT at this address — nothing to recover.');
    if (trxBal > 0n) {
      console.log(`   ${sunToTrx(trxBal)} TRX is here though — recover it with --native.`);
    }
    return;
  }
  if (!destination) return readOnlyHint(index, 'TRC20', '<yourWalletT...>');
  if (!isTronAddress(destination)) {
    console.error('Destination must be a base58 T… Tron address (not a 0x address).');
    process.exit(1);
  }

  // A TRC20 transfer from an address with no staked energy burns real TRX.
  // Top up before signing, or the transfer broadcasts and then fails on-chain.
  const needed = trxToSun(config.tron.gasTopupTrx);
  if (trxBal < needed) {
    if (!gasFunderPk) {
      console.error(
        `\nNot enough TRX for fees. Send ~${config.tron.gasTopupTrx} TRX to ${address}, then re-run.`,
      );
      process.exit(1);
    }
    console.log(`Funding ${config.tron.gasTopupTrx} TRX from the Tron gas key...`);
    const gasClient = tronClient(gasFunderPk);
    const fundTx = (await gasClient.trx.sendTransaction(
      address,
      Number(needed),
    )) as unknown as { txid?: string; transaction?: { txID?: string } };
    const fundTxId = fundTx.txid ?? fundTx.transaction?.txID;
    if (!fundTxId) {
      console.error('TRX top-up did not return a transaction id.');
      process.exit(1);
    }
    console.log(`  TRX funded: ${fundTxId}`);
    // Wait for the top-up to be usable before spending it as fees.
    await waitForTron(tronClient(), fundTxId);
  }

  const signClient = tronClient(pk);
  const signContract = await signClient.contract(
    TRC20_ABI as unknown as never[],
    config.tron.usdtContract,
  );
  console.log(`Sweeping ${fromTronBaseUnits(usdtBal)} USDT -> ${destination} ...`);
  const txId: string = await signContract
    .transfer(destination, usdtBal.toString())
    .send({ feeLimit: feeLimitSun(), callValue: 0 });
  const ok = await waitForTron(tronClient(), txId);
  console.log(`Done. tx: ${txId} (${ok ? 'SUCCESS' : 'NOT CONFIRMED — check the explorer'})`);
  console.log(`   https://tronscan.org/#/transaction/${txId}`);
}

/** Poll a Tron receipt until it lands or the bounded timeout expires. */
async function waitForTron(
  client: { trx: { getTransactionInfo(hash: string): Promise<unknown> } },
  txHash: string,
): Promise<boolean> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const info = (await client.trx.getTransactionInfo(txHash)) as {
        blockNumber?: number;
        receipt?: { result?: string };
      };
      if (info && info.blockNumber) {
        const result = info.receipt?.result;
        return result === undefined || result === 'SUCCESS';
      }
    } catch {
      /* not mined yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

// ---------------------------------------------------------------------------

function report(info: {
  network: string;
  index: number;
  address: string;
  usdt: string;
  native: string;
  pk: string;
}): void {
  console.log('──────────────────────────────────────────────');
  console.log(`Network         : ${info.network}`);
  console.log(`HD index        : ${info.index}`);
  console.log(`Deposit address : ${info.address}`);
  console.log(`USDT balance    : ${info.usdt}`);
  console.log(`Native balance  : ${info.native}`);
  console.log(`PRIVATE KEY     : ${info.pk}`);
  console.log('  ^ import into a wallet to control the address (keep secret).');
  console.log('──────────────────────────────────────────────');
}

function readOnlyHint(
  index: number,
  network: Network,
  example: string,
  native = false,
): void {
  const netFlag = network === 'BEP20' ? '' : `--network=${network} `;
  const coin =
    network === 'BEP20' ? 'BNB' : network === 'ERC20' ? 'ETH' : 'TRX';
  if (native) {
    console.log(`\nRead-only. To sweep the ${coin} out, re-run with a destination address:`);
    console.log(
      `  ./node_modules/.bin/tsx src/recover.ts ${netFlag}--native ${index} ${example}`,
    );
    // No gas key applies here: a native sweep funds its own fee out of the
    // balance, so passing one would do nothing.
    return;
  }
  console.log('\nRead-only. To sweep the USDT out, re-run with a destination address:');
  console.log(`  ./node_modules/.bin/tsx src/recover.ts ${netFlag}${index} ${example} [gasFunderPrivateKey]`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isInteger(args.index) || args.index < 0) usage();

  if (args.network === 'TRC20') {
    await recoverTrc20(args);
  } else {
    await recoverEvm(args);
  }
}

main().catch((err) => {
  console.error('recover failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
