/**
 * HD wallet derivation (BIP-44) using ethers v6.
 *
 * Deposit private keys are NEVER persisted. Each deposit address is derived from
 * the master mnemonic + a monotonic derivation index handed out by the DB.
 * The key is reconstructed on demand only when a sweep needs to sign, and is
 * discarded immediately after.
 *
 * Path scheme:  base = HD_DERIVATION_PATH (e.g. m/44'/60'/0'/0)
 *               address at index i => `${base}/${i}`
 *
 * The mnemonic in config is treated as sensitive: it is decrypted/materialised
 * only inside these helpers and never logged.
 *
 * ======================== WHY THE ACCOUNT NODE IS MEMOISED ===================
 * `Mnemonic.fromPhrase()` + `HDNodeWallet.fromMnemonic()` is a full PBKDF2-
 * HMAC-SHA512 (2048 iterations, pure JS, fully SYNCHRONOUS) seed derivation.
 * Measured on this codebase's ethers: ~2.0 ms, on top of ~1.4 ms to walk the
 * path — ~3.4 ms of un-yieldable event-loop burn per deposit address, for a
 * value that is a pure function of a constant. Node is single-threaded, so that
 * blocked every other in-flight request, not just payment creation.
 *
 * The seed and the account node are now built ONCE per process and reused. A
 * child derivation from the cached account node is ~0.28 ms — a 16x reduction
 * on both the creation path (deriveAddress) and the sweep path
 * (derivePrivateKey). The node is kept in memory, which is no weaker than the
 * status quo: `config.hd.mnemonic` is already resident for the process's life.
 */
import { HDNodeWallet, Mnemonic } from 'ethers';
import type { PoolClient } from 'pg';
import { config } from '../config/env';
import { query } from '../db/pool';
import { logger } from '../config/logger';

/** Highest index BIP-32 allows for a NON-hardened child. */
const MAX_NON_HARDENED_INDEX = 2 ** 31 - 1;

/**
 * The BIP-44 account node (the configured base path), built lazily and kept for
 * the life of the process.
 *
 * NOTE: In this reference build the mnemonic arrives from env in plaintext. In a
 * hardened deployment `config.hd.mnemonic` would be the envelope-encrypted blob
 * and we'd `decrypt()` it here; the seam is intentionally isolated to this
 * function, and now runs exactly once rather than once per address.
 */
let cachedAccount: HDNodeWallet | null = null;

function basePath(): string {
  return config.hd.derivationPath.replace(/\/+$/, '');
}

function accountNode(): HDNodeWallet {
  if (cachedAccount) return cachedAccount;

  const mnemonic = Mnemonic.fromPhrase(config.hd.mnemonic.trim());
  // Derive from the *root* (m); the base path is then applied once.
  const root = HDNodeWallet.fromMnemonic(mnemonic);
  const account = root.derivePath(relativePath(basePath()));

  // Equivalence guard, run once per process. `account.deriveChild(i)` is only
  // the same key as `root.derivePath(base + '/' + i)` when the final element is
  // non-hardened. That is always true for the plain integer indexes we hand out,
  // but an operator could set HD_DERIVATION_PATH to something this code has not
  // seen; deriving the WRONG address for a deposit would strand customer funds
  // at a key nothing in the system can find. Fail loudly at first use instead.
  const viaAccount = account.deriveChild(0).address;
  const viaRoot = root.derivePath(relativePath(`${basePath()}/0`)).address;
  if (viaAccount !== viaRoot) {
    throw new Error(
      'HD_DERIVATION_PATH is incompatible with cached-account derivation: ' +
        'the base path must not make the child index hardened.',
    );
  }

  cachedAccount = account;
  return cachedAccount;
}

function fullPath(index: number | bigint): string {
  return `${basePath()}/${index.toString()}`;
}

/**
 * Narrow a DB-supplied index (BIGINT, so a string in JS) to a usable BIP-32
 * child index. Throwing beats deriving a silently different key: a wrapped or
 * hardened index would produce an address the gateway could never sweep.
 */
function checkedIndex(index: number | bigint | string): number {
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n > MAX_NON_HARDENED_INDEX) {
    throw new Error(`HD derivation index out of range: ${index.toString()}`);
  }
  return n;
}

export interface DerivedAddress {
  address: string;
  path: string;
  index: number;
}

/** Name of the sequence created by sql/migrations/019_hd_index_sequence.sql. */
const INDEX_SEQUENCE = 'hd_deposit_index';
/** Postgres: undefined_table — also raised for a missing sequence. */
const UNDEFINED_TABLE = '42P01';

let warnedAboutMissingSequence = false;

/**
 * Atomically reserve the next HD derivation index.
 *
 * ======================== WHY THIS IS NOT A COUNTER ROW =====================
 * This used to be `UPDATE hd_counter SET next_index = next_index + 1 ...`,
 * called with the CALLER'S transaction client. That allocation was correct, but
 * Postgres holds a row lock until COMMIT — not, as the old docstring claimed,
 * for the duration of the statement. Every payment creation in the entire fleet
 * therefore serialised on one row for the whole of: the duplicate-order SELECT,
 * a ~3.4 ms synchronous key derivation, two INSERTs and the WAL commit. That
 * capped payment creation at roughly 100-200/second no matter how many API
 * replicas were running.
 *
 * `nextval()` takes no transactional lock and never blocks: concurrent callers
 * are serialised only for the microseconds of the sequence's own spinlock, and
 * the value is NOT rolled back with the transaction.
 *
 * Uniqueness is preserved absolutely — nextval never returns the same value
 * twice to two callers — and `idx_wallets_deriv` (UNIQUE derivation_index WHERE
 * type='deposit', sql/schema.sql) remains the backstop.
 *
 * GAPS ARE EXPECTED AND HARMLESS. A rolled-back creation burns its index; a
 * skipped index is simply an address no one was ever shown and no one can pay.
 * Nothing in the codebase scans indexes densely: they are only ever read back
 * per-wallet (workers/index.ts sweep, routes/account.ts, unexpectedDepositService)
 * or passed by hand to src/recover.ts. The fiat-quote path at
 * services/paymentService.ts already accepts the same tradeoff.
 *
 * ================== WHY IT STILL TAKES AN OPTIONAL CLIENT ===================
 * The lock was the defect, not the client. `nextval()` takes no transactional
 * lock at all, so running it on a caller's connection costs that caller
 * nothing — whereas NOT running it there costs a NESTED POOL ACQUISITION.
 *
 * The hosted-checkout path (routes/paymentLinks.ts) opens a transaction to
 * claim the link's single use and passes that client into createPayment. If
 * this function reaches for the pool itself, that request holds one connection
 * while waiting for a second. With DB_POOL_MAX concurrent checkout starts in
 * one process, every connection is held by a transaction waiting for a
 * connection only it can free — a self-inflicted stall that unwinds as 503s
 * after connectionTimeoutMillis. Nothing is lost when it happens (the claim
 * rolls back, no index is burned, no payment exists), but it is an outage on
 * exactly the concurrency this change set exists to support.
 *
 * So: use the caller's client when there is one, and wrap it in a SAVEPOINT so
 * a pre-migration 42P01 cannot poison the caller's transaction — which is the
 * one real hazard of borrowing it. Callers with no transaction open pass
 * nothing and get their own pooled connection, as before.
 */
export async function getNextDerivationIndex(client?: PoolClient): Promise<number> {
  if (client) return reserveOnClient(client);
  try {
    // Parameterised (the codebase interpolates nothing into SQL): the regclass
    // cast resolves the name, and raises the same 42P01 when it does not exist.
    const rows = await query<{ reserved_index: string }>(
      `SELECT nextval($1::regclass)::text AS reserved_index`,
      [INDEX_SEQUENCE],
    );
    return checkedIndex(rows[0].reserved_index);
  } catch (err) {
    if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err;
    return legacyCounterIndex();
  }
}

/**
 * Reserve on a caller's open transaction.
 *
 * THE SAVEPOINT IS THE WHOLE POINT. In Postgres any failed statement aborts the
 * entire transaction — every later statement gets 25P02 until rollback — so a
 * bare `nextval()` against a database where migration 019 has not been applied
 * would take the caller's link claim and payment INSERTs down with it. The
 * savepoint scopes that failure to this statement, leaving the caller's
 * transaction usable so the legacy fallback below can run in it.
 *
 * Rolling back to the savepoint cannot un-issue an index: a sequence value is
 * non-transactional, and in the only case we roll back none was issued (the
 * sequence did not exist). Uniqueness is therefore identical to the pooled
 * path, and `idx_wallets_deriv` is still the backstop underneath both.
 *
 * The legacy branch DOES hold the hd_counter row lock until the caller commits.
 * That is the pre-migration behaviour this file used to have on every path,
 * now confined to the hosted-checkout path on a database that has not applied
 * 019 — strictly better than before, and it disappears the moment 019 lands.
 */
async function reserveOnClient(client: PoolClient): Promise<number> {
  await client.query('SAVEPOINT hd_index_reserve');
  try {
    const res = await client.query<{ reserved_index: string }>(
      `SELECT nextval($1::regclass)::text AS reserved_index`,
      [INDEX_SEQUENCE],
    );
    await client.query('RELEASE SAVEPOINT hd_index_reserve');
    return checkedIndex(res.rows[0].reserved_index);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT hd_index_reserve');
    await client.query('RELEASE SAVEPOINT hd_index_reserve');
    if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err;
    warnMissingSequenceOnce();
    const res = await client.query<{ reserved_index: string }>(`
      UPDATE hd_counter
         SET next_index = next_index + 1
       WHERE id = 1
       RETURNING (next_index - 1)::text AS reserved_index
    `);
    return checkedIndex(res.rows[0].reserved_index);
  }
}

/**
 * Pre-migration fallback: the original single-row counter.
 *
 * Reached ONLY when the sequence does not exist (42P01), which is a
 * deployment-wide, deterministic condition — never a transient error — so the
 * fleet cannot be split between the two allocators by a blip. The decision is
 * re-made on every call rather than cached, so the first creation after
 * migration 019 lands switches over immediately.
 *
 * Migration 019 seeds the sequence 1,000,000 above the counter, so BOTH
 * allocators can be live at once — which they necessarily are during a rolling
 * restart, because old replicas keep using hd_counter — without their ranges
 * ever meeting. See that file's CUTOVER SAFETY note for why the margin has to
 * cover the whole deploy window rather than a single in-flight statement.
 *
 * Unlike the old code this runs OUTSIDE any caller transaction, so the row lock
 * is released when the statement commits rather than being held across the
 * derivation and the INSERTs.
 */
function warnMissingSequenceOnce(): void {
  if (warnedAboutMissingSequence) return;
  warnedAboutMissingSequence = true;
  logger.warn(
    { sequence: INDEX_SEQUENCE },
    'HD index sequence missing; falling back to the hd_counter row. ' +
      'Apply sql/migrations/019_hd_index_sequence.sql to remove the fleet-wide lock.',
  );
}

async function legacyCounterIndex(): Promise<number> {
  warnMissingSequenceOnce();
  const rows = await query<{ reserved_index: string }>(`
    UPDATE hd_counter
       SET next_index = next_index + 1
     WHERE id = 1
     RETURNING (next_index - 1)::text AS reserved_index
  `);
  return checkedIndex(rows[0].reserved_index);
}

/**
 * Derive the deposit address for a given index. Pure function of mnemonic+index.
 */
export function deriveAddress(index: number | bigint): DerivedAddress {
  const i = checkedIndex(index);
  const node = accountNode().deriveChild(i);
  return {
    address: node.address,
    path: fullPath(i),
    index: i,
  };
}

/**
 * Derive the private key (0x-hex) for a given index. Used ONLY by the sweep worker.
 * Never store or log the return value.
 */
export function derivePrivateKey(index: number | bigint): string {
  return accountNode().deriveChild(checkedIndex(index)).privateKey;
}

/**
 * ethers' HDNodeWallet.fromMnemonic() returns a node already positioned at "m".
 * derivePath() expects a path *relative* to the current node, so strip a leading
 * "m/" if present.
 */
function relativePath(absolute: string): string {
  return absolute.replace(/^m\//, '');
}
