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

/**
 * Extend the lease, but ONLY while we still hold it. Token-checked for the same
 * reason the release is: a lapsed holder must not push out the TTL of whoever
 * took the lock after it.
 *
 * Renewal exists because LOCK_TTL_MS was a hard ceiling on the critical section,
 * not merely on a crashed holder. The section is a nonce read, a signature, a DB
 * write and a broadcast; when an RPC goes slow, the lease lapses UNDER a holder
 * that is still running, a second signer takes the lock, and both pick the same
 * nonce — precisely the collision this file exists to prevent, and the one whose
 * loser is recorded as `sent` against a hash that never lands.
 */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

/** Three renewal attempts per lease, so two may fail before one expires. */
const RENEW_INTERVAL_MS = Math.floor(LOCK_TTL_MS / 3);

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
 *
 * The lease is renewed in the background for as long as `fn` runs, so a slow
 * broadcast can no longer lose the lock to a second signer mid-operation.
 *
 * `fn` receives an `assertHeld()` callback. Calling it immediately before any
 * step that SIGNS or BROADCASTS turns "the lease lapsed and we signed anyway"
 * into a plain, retryable throw before a transaction exists. It is optional by
 * design — existing callers take no argument and are unaffected — but a caller
 * that signs should adopt it, because this watchdog makes the lapse rare and
 * only assertHeld makes it harmless.
 */
export async function withChainLock<T>(
  network: string,
  role: ChainLockRole,
  fn: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  const key = chainLockKey(network, role);
  const token = nextToken();
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  let acquired = false;
  let acquiredAt = 0;
  while (Date.now() < deadline) {
    // Timestamped BEFORE the round trip: Redis started the TTL when it ran the
    // SET, which is no later than this, so the lease estimate can only be short.
    const attemptedAt = Date.now();
    const res = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX');
    if (res === 'OK') {
      acquired = true;
      acquiredAt = attemptedAt;
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

  // Lease bookkeeping. `leaseExpiresAt` is deliberately computed from the moment
  // the renewal was SENT, not the moment it was acknowledged, so clock drift and
  // Redis latency shorten our estimate rather than lengthening it.
  let leaseExpiresAt = acquiredAt + LOCK_TTL_MS;
  let lostReason: string | null = null;

  const renewer = setInterval(() => {
    const sentAt = Date.now();
    void redis
      .eval(RENEW_SCRIPT, 1, key, token, String(LOCK_TTL_MS))
      .then((res) => {
        if (res === 1) {
          leaseExpiresAt = sentAt + LOCK_TTL_MS;
          return;
        }
        // Sticky: a 0 means the key is gone or belongs to someone else, and our
        // token can never own it again. Every later renewal would return 0 too.
        lostReason = 'the lock was taken by another signer or expired before renewal';
        logger.error(
          { network, role },
          'lost the chain signing lease while the critical section was still running',
        );
      })
      .catch((err) => {
        // A Redis error is NOT proof the lease is gone, so it is not made
        // sticky — the next tick may well succeed. If Redis stays unreachable,
        // leaseExpiresAt simply passes and assertHeld reports it accurately.
        logger.warn({ err, network, role }, 'failed to renew chain signing lock');
      });
  }, RENEW_INTERVAL_MS);
  // Never let the watchdog hold the process open on shutdown.
  renewer.unref();

  const assertHeld = (): void => {
    if (lostReason !== null) {
      throw new Error(`lost the ${network} ${role} signing lock: ${lostReason}`);
    }
    if (Date.now() >= leaseExpiresAt) {
      throw new Error(
        `the ${network} ${role} signing lease expired mid-operation ` +
          `(no successful renewal within ${LOCK_TTL_MS}ms) — refusing to sign`,
      );
    }
  };

  try {
    return await fn(assertHeld);
  } finally {
    clearInterval(renewer);
    // Deliberately no throw here on a lost lease: `fn` has already run, and
    // turning a completed broadcast into a thrown error is how a payout gets
    // marked failed and re-driven against money that already left the wallet.
    // The error line above is the signal; assertHeld is the prevention.
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      // The lock expires on its own, so a failed release is not correctness-
      // critical — but it does mean the next signer waits out the TTL.
      logger.warn({ err, network, role }, 'failed to release chain signing lock');
    }
  }
}
