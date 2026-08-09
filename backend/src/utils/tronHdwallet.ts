/**
 * Tron HD wallet derivation (BIP-44, coin type 195).
 *
 * Mirrors utils/hdwallet.ts exactly in contract and in security posture:
 * deposit private keys are NEVER persisted — they are reconstructed from the
 * master mnemonic + derivation index only when a sweep needs to sign, then
 * discarded. Nothing here is logged.
 *
 * Path scheme:  base = TRON_HD_DERIVATION_PATH (m/44'/195'/0'/0)
 *               address at index i => `${base}/${i}`
 *
 * The SAME mnemonic backs both chains. BIP-44 coin type keeps the key spaces
 * disjoint (60 = BSC/EVM, 195 = Tron), so a BEP20 deposit key and a TRC20
 * deposit key at the same index are unrelated. Reusing the mnemonic means one
 * seed to back up — losing it still loses both, exactly as before.
 *
 * NOTE: the derivation INDEX is shared with the BEP20 side (one `hd_counter`).
 * Indexes are never reused across networks, which keeps `wallets.derivation_index`
 * globally unique and makes a sweep unambiguous given only the wallet row.
 */
import { TronWeb } from 'tronweb';
import { config } from '../config/env';

export interface DerivedTronAddress {
  address: string;
  path: string;
  index: number;
}

function fullPath(index: number | bigint): string {
  const base = config.tron.derivationPath.replace(/\/+$/, '');
  return `${base}/${index.toString()}`;
}

/**
 * Derive the Tron deposit address for an index. Pure fn of mnemonic + index.
 * Throws if TRON_HD_DERIVATION_PATH is not a valid Tron path (tronweb enforces
 * the m/44'/195' prefix), which surfaces a misconfiguration loudly at the first
 * TRC20 payment rather than silently minting addresses on the wrong curve.
 */
export function deriveTronAddress(index: number | bigint): DerivedTronAddress {
  const path = fullPath(index);
  const account = TronWeb.fromMnemonic(config.hd.mnemonic.trim(), path);
  return { address: account.address, path, index: Number(index) };
}

/**
 * Derive the Tron private key (0x-hex) for an index. Used ONLY by the sweeper.
 * Never store or log the return value.
 */
export function deriveTronPrivateKey(index: number | bigint): string {
  const account = TronWeb.fromMnemonic(config.hd.mnemonic.trim(), fullPath(index));
  return account.privateKey;
}
