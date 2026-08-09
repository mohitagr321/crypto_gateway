/**
 * Cross-process mutex for hot-wallet signing.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every outbound transfer on a chain is signed by ONE key: the central wallet
 * for payouts and admin withdrawals, the gas station for sweep top-ups. On an
 * EVM chain each transaction from a key carries a nonce, and ethers derives it
 * per transaction with eth_getTransactionCount(address, 'pending').
 *
 * The sweep and payout workers run at concurrency 3, so three transfers could be
 * signed at once from the same key. All three read the SAME pending nonce and
 * broadcast three transactions claiming it. One is mined; the others are
 * rejected ("nonce too low", "replacement transaction underpriced"). That alone
 * is only wasteful — the damage is what came next: the rejection surfaced as a
 * thrown error, the payout was marked failed, and BullMQ retried it. On a retry
 * where the ORIGINAL transaction had actually been accepted, the merchant was
 * paid twice.
 *
 * Serialising signing per key removes the collision at the source. Nonce pinning
 * in payoutService removes the double-spend even if a collision somehow happens.
 * Both are needed: this makes the failure rare, that makes it harmless.
 *
 * WHY REDIS AND NOT AN IN-PROCESS MUTEX
 * -------------------------------------
 * docs/deployment.md documents the worker as horizontally scalable
 * (`docker compose up -d --scale worker=3`). An in-process mutex would silently
 * stop working the moment anyone does that, which is the worst possible failure
 * mode for a money path. The lock therefore lives in Redis, which every worker
 * already shares.
 *
 * SCOPE OF THE LOCK
 * -----------------
 * Hold it across nonce selection and broadcast ONLY — not across confirmation.
 * Once the node has accepted the transaction its pending nonce has advanced, so
 * the next signer is safe to proceed. Waiting for a block inside the lock would
 * cut throughput to one transfer per block for no benefit.
 */
import { redis } from '../db/redis';
import { logger } from '../config/logger';

/**
 * How long a held lock survives if the holder dies mid-broadcast. Long enough to
 * cover a slow RPC round-trip, short enough that a crashed worker does not stall
 * the chain for minutes.
 */
const LOCK_TTL_MS = 60_000;

/** Give up (and let the queue retry) rather than queueing forever behind a jam. */
const ACQUIRE_TIMEOUT_MS = 45_000;

const RETRY_DELAY_MS = 100;

/**
 * Release only if we still hold it. Without the token check, a holder whose lock
 * had already expired would delete the NEXT holder's lock — turning a slow
 * broadcast into exactly the concurrent-signing bug this prevents.
 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

let tokenCounter = 0;

function nextToken(): string {
  tokenCounter += 1;
  return `${process.pid}-${tokenCounter}-${process.hrtime.bigint().toString(36)}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Identifies one signing key. Two different roles on the same chain (central vs
 * gas station) are different keys and must NOT share a lock — serialising them
 * together would halve throughput for no safety gain.
 */
export type ChainLockRole = 'central' | 'gas';

export function chainLockKey(network: string, role: ChainLockRole): string {
  return `chainlock:${network}:${role}`;
}

/**
 * Run `fn` while holding the signing lock for (network, role).
 *
 * Throws if the lock cannot be acquired within ACQUIRE_TIMEOUT_MS — the caller
 * is a BullMQ job, so throwing means "retry later", which is the correct
 * response to a busy key.
 */
export async function withChainLock<T>(
  network: string,
  role: ChainLockRole,
  fn: () => Promise<T>,
): Promise<T> {
  const key = chainLockKey(network, role);
  const token = nextToken();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  let acquired = false;
  while (Date.now() < deadline) {
    const res = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    if (res === 'OK') {
      acquired = true;
      break;
    }
    await sleep(RETRY_DELAY_MS);
  }

  if (!acquired) {
    throw new Error(
      `timed out acquiring the ${network} ${role} signing lock after ` +
        `${ACQUIRE_TIMEOUT_MS}ms — another transfer is still broadcasting`,
    );
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      // The lock expires on its own, so a failed release is not correctness-
      // critical — but it does mean the next signer waits out the TTL.
      logger.warn({ err, network, role }, 'failed to release chain signing lock');
    }
  }
}
