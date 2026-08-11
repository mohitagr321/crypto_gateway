/**
 * Bitcoin client wiring: Esplora HTTP API + BIP-84 key derivation.
 *
 * Kept separate from bitcoinAdapter.ts so the adapter and the listener share one
 * API client and one derivation path, exactly as tron.ts serves the Tron pair.
 *
 * ============================ NO ACCOUNT, NO NODE ============================
 * Two things are unlike every other chain here.
 *
 * There is no node to run and no key to buy: Blockstream's Esplora and
 * mempool.space expose the same open, keyless API on mainnet AND testnet. That
 * makes Bitcoin the one chain whose settlement path can be proven end to end
 * without spending anything — testnet coins come from a faucet.
 *
 * And there is no account balance. An address "holds" a set of unspent
 * transaction outputs (UTXOs); spending consumes them whole and creates new
 * ones. A balance is a SUM over that set, and a transfer is a rearrangement of
 * it. That is why the adapter builds transactions from inputs and outputs rather
 * than calling a transfer function.
 *
 * ============================ DERIVATION: ethers DOES THE MATHS ==============
 * BIP-32 derivation is secp256k1 arithmetic, identical to Ethereum's — only the
 * ADDRESS ENCODING differs. So the same `ethers` HD machinery that derives EVM
 * deposit addresses derives Bitcoin ones too, from the SAME mnemonic, and
 * bitcoinjs-lib is needed only to encode the public key as bech32 and to build
 * and sign transactions.
 *
 * That also means no second BIP-32 dependency, and no native/WASM secp256k1
 * module: signing goes through a small adapter over ethers' SigningKey (see
 * `signerFor`).
 *
 * BIP-84 (m/84'/0'/0'/0/i, native segwit, bc1q…) rather than BIP-44: segwit
 * inputs are ~40% smaller, and on a chain where the fee IS the transaction size
 * that is a direct and permanent saving on every sweep.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { HDNodeWallet, Mnemonic, SigningKey, getBytes } from 'ethers';
import { config } from '../config/env';
import { logger } from '../config/logger';

/** BTC has 8 decimals; 1 BTC = 100,000,000 satoshi. */
const SATS_PER_BTC = 100_000_000n;

/** The bitcoinjs network object for the configured chain. */
export function btcNetwork(): bitcoin.Network {
  return config.btc.isTestnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Human BTC string -> satoshi.
 *
 * Parsed as a decimal STRING rather than via Number: 0.1 + 0.2 is not 0.3 in
 * binary floating point, and a satoshi lost to rounding is a real (if small)
 * discrepancy that compounds across a ledger.
 */
export function btcToSats(btc: string): bigint {
  const s = String(btc ?? '0').trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') {
    throw new Error(`"${btc}" is not a valid BTC amount`);
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > 8) {
    throw new Error(`"${btc}" has more than 8 decimal places (BTC's precision)`);
  }
  const padded = (frac + '00000000').slice(0, 8);
  return BigInt(whole || '0') * SATS_PER_BTC + BigInt(padded || '0');
}

/** Satoshi -> human BTC string, always 8 dp. */
export function satsToBtc(sats: bigint): string {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = (abs % SATS_PER_BTC).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/** The BIP-84 account node, derived from the gateway's shared mnemonic. */
function accountNode(): HDNodeWallet {
  const mnemonic = Mnemonic.fromPhrase(config.hd.mnemonic);
  return HDNodeWallet.fromMnemonic(mnemonic, config.btc.derivationPath);
}

export interface BtcKey {
  address: string;
  path: string;
  /** 0x-prefixed hex, as ethers produces it. */
  privateKey: string;
  publicKey: Buffer;
}

/**
 * Derive the Bitcoin key and p2wpkh address for an HD index.
 *
 * Pure function of (mnemonic, path, index) — the same index always gives the
 * same address, which is what makes a deposit recoverable from nothing but its
 * index. Note this is a DIFFERENT address from index N on the EVM chains:
 * Bitcoin uses coin type 0, they use 60.
 */
export function deriveBtc(index: number): BtcKey {
  const node = accountNode().deriveChild(index);
  const publicKey = Buffer.from(getBytes(node.publicKey));
  const { address } = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: btcNetwork() });
  if (!address) throw new Error(`could not derive a Bitcoin address for index ${index}`);
  return { address, path: node.path ?? `${config.btc.derivationPath}/${index}`, privateKey: node.privateKey, publicKey };
}

/** The gateway's central (collection) address. */
export function centralBtcAddress(): string {
  // Derived from the mnemonic, not configured, for the same reason the EVM
  // central address is derived from its key: a configured value that disagrees
  // with the key is a way to sweep funds somewhere payouts cannot spend from.
  return deriveBtc(config.btc.centralDerivationIndex).address;
}

/**
 * A bitcoinjs `Signer` backed by ethers' secp256k1.
 *
 * bitcoinjs-lib's own ECPair needs `tiny-secp256k1`, a native/WASM module. This
 * avoids that dependency entirely: PSBT signing only needs something that can
 * produce a 64-byte compact signature over a hash, and ethers already ships a
 * well-exercised secp256k1 for exactly that.
 */
export function signerFor(key: BtcKey): bitcoin.Signer {
  const sk = new SigningKey(key.privateKey);
  return {
    publicKey: key.publicKey,
    sign(hash: Buffer): Buffer {
      const sig = sk.sign(hash);
      // r and s, 32 bytes each, big-endian — the compact form bitcoinjs wants.
      return Buffer.concat([
        Buffer.from(getBytes(sig.r)),
        Buffer.from(getBytes(sig.s)),
      ]);
    },
  };
}

/** True if `address` is well-formed for the configured Bitcoin network. */
export function isBtcAddress(address: string): boolean {
  try {
    // Throws for a malformed address, and — importantly — for a MAINNET address
    // on testnet or vice versa, which is the mistake most likely to send funds
    // somewhere unrecoverable.
    bitcoin.address.toOutputScript(address, btcNetwork());
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Esplora API
// ---------------------------------------------------------------------------

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  /** Block height, or null while still in the mempool. */
  height: number | null;
  /**
   * Esplora's own confirmed flag. Always true for anything `listUtxos` returns;
   * only `listAllUtxos` (diagnostics) ever hands back false.
   */
  confirmed: boolean;
}

export interface EsploraTxStatus {
  confirmed: boolean;
  block_height?: number;
}

export interface EsploraVout {
  scriptpubkey_address?: string;
  value: number;
}

export interface EsploraTx {
  txid: string;
  status: EsploraTxStatus;
  vout: EsploraVout[];
  vin: Array<{ prevout?: { scriptpubkey_address?: string; value?: number } }>;
}

const TIMEOUT_MS = 15_000;

async function esplora<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${config.btc.apiUrl.replace(/\/+$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Esplora ${res.status} for ${path}: ${body.slice(0, 200)}`);
    }
    // Some endpoints return plain text (tip height, a broadcast txid).
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as unknown as T;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Current chain tip height. */
export async function tipHeight(): Promise<number> {
  return Number(await esplora<string>('/blocks/tip/height'));
}

/**
 * Confirmed spendable balance of an address, in satoshi.
 *
 * Deliberately EXCLUDES unconfirmed (mempool) outputs. A sweep that spends an
 * unconfirmed input is valid but fragile — it depends on the parent confirming,
 * and if the parent is replaced the sweep dies with it. Waiting costs a few
 * minutes; not waiting costs a stuck settlement.
 */
export async function addressBalanceSats(address: string): Promise<bigint> {
  const stats = await esplora<{
    chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  }>(`/address/${address}`);
  const funded = BigInt(stats.chain_stats?.funded_txo_sum ?? 0);
  const spent = BigInt(stats.chain_stats?.spent_txo_sum ?? 0);
  return funded - spent;
}

/**
 * Confirmed UTXOs at an address, oldest first.
 *
 * The ORDER is deliberate and load-bearing for payouts: selection walks this
 * list, so a deterministic order means re-running the selection over an
 * unchanged UTXO set produces the same inputs and therefore the same signed
 * transaction. Sorting by (height, txid, vout) is stable across API calls in a
 * way the server's own ordering is not promised to be.
 */
export async function listUtxos(address: string): Promise<Utxo[]> {
  return (await listAllUtxos(address)).filter((u) => u.confirmed);
}

/**
 * EVERY UTXO at an address, confirmed or not, in the same deterministic order.
 *
 * DIAGNOSTIC ONLY. Nothing selects sweep or payout inputs from this — see
 * listUtxos above for why an unconfirmed parent is not something this system
 * spends. It exists so a starved input selection can tell "the wallet is empty"
 * apart from "everything the wallet has is change from the payout broadcast a
 * minute ago", which produce the same error text today and have opposite
 * remedies (fund it, versus wait one block).
 *
 * Unconfirmed entries sort LAST. That cannot alter listUtxos' ordering — every
 * row it returns is confirmed and so carries a height — it only keeps this view
 * in a sensible shape.
 */
export async function listAllUtxos(address: string): Promise<Utxo[]> {
  const raw = await esplora<
    Array<{ txid: string; vout: number; value: number; status: EsploraTxStatus }>
  >(`/address/${address}/utxo`);
  return raw
    .map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      height: u.status?.block_height ?? null,
      confirmed: Boolean(u.status?.confirmed),
    }))
    .sort(
      (a, b) =>
        (a.height ?? Number.MAX_SAFE_INTEGER) - (b.height ?? Number.MAX_SAFE_INTEGER) ||
        a.txid.localeCompare(b.txid) ||
        a.vout - b.vout,
    );
}

/** Transactions involving an address, newest first (Esplora's own order). */
export async function addressTxs(address: string): Promise<EsploraTx[]> {
  return esplora<EsploraTx[]>(`/address/${address}/txs`);
}

/** One transaction, or null when the API does not know it. */
export async function getTx(txid: string): Promise<EsploraTx | null> {
  try {
    return await esplora<EsploraTx>(`/tx/${txid}`);
  } catch {
    return null;
  }
}

/**
 * Fee rate to use, in satoshi per vbyte.
 *
 * Clamped at both ends. Esplora occasionally returns an estimate below the
 * network's relay minimum, which produces a transaction no node will accept and
 * a sweep that fails forever for no visible reason. The upper clamp is a
 * separate decision — see the adapter, which DEFERS rather than overpaying.
 */
export async function feeRateSatPerVb(): Promise<number> {
  try {
    const estimates = await esplora<Record<string, number>>('/fee-estimates');
    const target = String(config.btc.feeTargetBlocks);
    const raw = estimates[target] ?? estimates['6'] ?? estimates['1'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.max(config.btc.minFeeRate, Math.ceil(raw));
    }
  } catch (err) {
    logger.warn({ err }, 'btc: fee estimate unavailable; using the configured floor');
  }
  return config.btc.minFeeRate;
}

/**
 * Broadcast a raw transaction. Returns its txid.
 *
 * "Already known" is treated as SUCCESS, not an error: re-broadcasting is the
 * normal retry path, and a transaction already in the mempool or a block is
 * exactly the outcome the retry wanted. This mirrors the EVM broadcast, and it
 * is what stops a retry loop turning one payment into two.
 */
export async function broadcastRawTx(hex: string, expectedTxid: string): Promise<string> {
  try {
    const txid = await esplora<string>('/tx', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: hex,
    });
    return String(txid).trim();
  } catch (err) {
    const message = (err as Error)?.message?.toLowerCase() ?? '';
    const alreadyKnown =
      message.includes('already') ||
      message.includes('txn-already-in-mempool') ||
      message.includes('txn-already-known') ||
      message.includes('duplicate');
    if (alreadyKnown) {
      logger.info({ txid: expectedTxid }, 'btc: transaction already known; treating as sent');
      return expectedTxid;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Size / fee arithmetic
// ---------------------------------------------------------------------------

/**
 * Estimated virtual size of a p2wpkh transaction, in vbytes.
 *
 * On Bitcoin the fee is size x rate, so this IS the fee calculation. The
 * constants are the standard native-segwit figures:
 *   overhead  10.5 vB  (version, counts, locktime, segwit marker+flag)
 *   input     68   vB  (outpoint 36 + sequence 4 + witness ~27 discounted)
 *   output    31   vB  (value 8 + script 23)
 *
 * Rounded UP, because underestimating produces a transaction below the relay
 * minimum fee rate that no node accepts — a silent stall rather than a loud
 * failure.
 */
export function estimateVsize(inputs: number, outputs: number): number {
  return Math.ceil(10.5 + 68 * inputs + 31 * outputs);
}

/**
 * Minimum value an output may carry, in satoshi.
 *
 * Below this a p2wpkh output is "dust": the network will not relay it, because
 * it would cost more to spend than it is worth. Change that falls under this is
 * dropped into the fee instead of being created — see the adapter.
 */
export const DUST_LIMIT_SATS = 294n;
