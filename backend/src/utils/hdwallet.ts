/**
 * HD wallet derivation (BIP-44) using ethers v6.
 *
 * Deposit private keys are NEVER persisted. Each deposit address is derived from
 * the master mnemonic + a monotonic derivation index handed out by the DB
 * (`hd_counter`). The key is reconstructed on demand only when a sweep needs to
 * sign, and is discarded immediately after.
 *
 * Path scheme:  base = HD_DERIVATION_PATH (e.g. m/44'/60'/0'/0)
 *               address at index i => `${base}/${i}`
 *
 * The mnemonic in config is treated as sensitive: it is decrypted/materialised
 * only inside these helpers and never logged.
 */
import { HDNodeWallet, Mnemonic } from 'ethers';
import { PoolClient } from 'pg';
import { config } from '../config/env';
import { query } from '../db/pool';

/**
 * Build the root HDNodeWallet from the configured mnemonic.
 * NOTE: In this reference build the mnemonic arrives from env in plaintext. In a
 * hardened deployment `config.hd.mnemonic` would be the envelope-encrypted blob
 * and we'd `decrypt()` it here; the seam is intentionally isolated to this function.
 */
function rootFromMnemonic(): HDNodeWallet {
  const mnemonic = Mnemonic.fromPhrase(config.hd.mnemonic.trim());
  // Derive from the *root* (m); we then apply the full absolute path per index.
  return HDNodeWallet.fromMnemonic(mnemonic);
}

function fullPath(index: number | bigint): string {
  const base = config.hd.derivationPath.replace(/\/+$/, '');
  return `${base}/${index.toString()}`;
}

export interface DerivedAddress {
  address: string;
  path: string;
  index: number;
}

/**
 * Atomically reserve the next HD derivation index.
 *
 * Uses `UPDATE ... RETURNING` on the single-row `hd_counter`, which takes a row
 * lock for the duration of the statement — two concurrent callers can never
 * receive the same index. Optionally participates in a caller transaction.
 */
export async function getNextDerivationIndex(client?: PoolClient): Promise<number> {
  const sql = `
    UPDATE hd_counter
       SET next_index = next_index + 1
     WHERE id = 1
     RETURNING next_index - 1 AS reserved_index
  `;
  if (client) {
    const res = await client.query<{ reserved_index: string }>(sql);
    return Number(res.rows[0].reserved_index);
  }
  const rows = await query<{ reserved_index: string }>(sql);
  return Number(rows[0].reserved_index);
}

/**
 * Derive the deposit address for a given index. Pure function of mnemonic+index.
 */
export function deriveAddress(index: number | bigint): DerivedAddress {
  const path = fullPath(index);
  const root = rootFromMnemonic();
  const node = root.derivePath(relativePath(path));
  return {
    address: node.address,
    path,
    index: Number(index),
  };
}

/**
 * Derive the private key (0x-hex) for a given index. Used ONLY by the sweep worker.
 * Never store or log the return value.
 */
export function derivePrivateKey(index: number | bigint): string {
  const path = fullPath(index);
  const root = rootFromMnemonic();
  const node = root.derivePath(relativePath(path));
  return node.privateKey;
}

/**
 * ethers' HDNodeWallet.fromMnemonic() returns a node already positioned at "m".
 * derivePath() expects a path *relative* to the current node, so strip a leading
 * "m/" if present.
 */
function relativePath(absolute: string): string {
  return absolute.replace(/^m\//, '');
}
