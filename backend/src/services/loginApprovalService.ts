/**
 * Login approvals: a correct password buys a pending request, not a session.
 *
 * The security model, the two-secret split and the reason the emailed link is
 * not itself the approval are all documented in
 * sql/migrations/027_login_approvals.sql. Read that first — this file is the
 * mechanism, that file is the argument.
 *
 * WHAT THIS SERVICE GUARANTEES:
 *
 *   - Every state change is a single conditional UPDATE ... RETURNING, so two
 *     concurrent clicks (approve in one tab, reject in another; two taps on a
 *     flaky phone connection) cannot both win. Exactly one matches a row.
 *   - A session can be collected at most once. `consume` moves the row to
 *     'consumed' in the same statement that reads it.
 *   - Expiry is enforced in SQL, not in JS. A row that has aged out is simply
 *     not matched by any of the statements below, so there is no window where
 *     the application's clock and the database's disagree.
 */
import { query, queryOne } from '../db/pool';
import { randomToken, sha256Hex } from '../utils/crypto';
import type { DeviceInfo } from '../utils/deviceInfo';

/** How long a sign-in attempt stays answerable. */
export const APPROVAL_TTL_MS = 10 * 60_000;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed';

export interface ApprovalRow {
  id: string;
  user_id: string;
  status: ApprovalStatus;
  ip: string | null;
  user_agent: string | null;
  device_label: string | null;
  device_kind: string | null;
  panel: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface CreatedApproval {
  /** For the browser that authenticated. Never emailed. */
  challenge: string;
  /** For the email link. Never returned to the browser. */
  actionToken: string;
  expiresAt: Date;
}

/**
 * Open a sign-in request. The caller has ALREADY verified the password and any
 * second factor — this function is not an authentication step and must never be
 * reached by an unauthenticated request.
 *
 * Any older pending request for the same user is rejected first. A merchant who
 * hits sign-in twice should not be left with two live links, only one of which
 * works; and if the second attempt is an attacker racing the first, the account
 * holder should be answering the most recent one rather than a stale one.
 */
export async function createApproval(opts: {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  device: DeviceInfo;
  panel: 'merchant' | 'admin';
}): Promise<CreatedApproval> {
  const challenge = randomToken(32);
  const actionToken = randomToken(32);
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);

  await query(
    `UPDATE login_approvals
        SET status = 'rejected', decided_at = now()
      WHERE user_id = $1 AND status = 'pending'`,
    [opts.userId],
  );

  await query(
    `INSERT INTO login_approvals
       (user_id, challenge_hash, action_hash, ip, user_agent,
        device_label, device_kind, panel, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      opts.userId,
      sha256Hex(challenge),
      sha256Hex(actionToken),
      opts.ip,
      opts.userAgent,
      opts.device.label,
      opts.device.kind,
      opts.panel,
      expiresAt,
    ],
  );

  return { challenge, actionToken, expiresAt };
}

/**
 * Look up a request by its EMAIL token, for the page that asks the account
 * holder to decide. Read-only: rendering the page must not change the state, or
 * a mail scanner fetching the link would burn the request.
 *
 * Returns the row whatever its status — the page needs to be able to say "this
 * was already approved" or "this expired" rather than showing a dead end.
 */
export async function findByActionToken(actionToken: string): Promise<ApprovalRow | null> {
  return queryOne<ApprovalRow>(
    `SELECT id, user_id, status, ip, user_agent, device_label, device_kind,
            panel, created_at, expires_at
       FROM login_approvals
      WHERE action_hash = $1`,
    [sha256Hex(actionToken)],
  );
}

/**
 * Record the decision. `pending` in the WHERE clause is what makes this
 * idempotent-safe: a second press, a double-submit, or an approve racing a
 * reject all resolve to exactly one winner and the loser gets null.
 *
 * The expiry check lives here too, so a request answered one second late is
 * refused rather than silently accepted.
 */
export async function decide(
  actionToken: string,
  decision: 'approved' | 'rejected',
): Promise<ApprovalRow | null> {
  return queryOne<ApprovalRow>(
    `UPDATE login_approvals
        SET status = $2, decided_at = now()
      WHERE action_hash = $1
        AND status = 'pending'
        AND expires_at > now()
      RETURNING id, user_id, status, ip, user_agent, device_label, device_kind,
                panel, created_at, expires_at`,
    [sha256Hex(actionToken), decision],
  );
}

/**
 * What the waiting browser is told. Read-only and cheap — this is polled.
 *
 * An unknown challenge and an expired one both come back as `expired` rather
 * than as separate answers. The browser has no use for the difference, and
 * collapsing them means a caller cannot use this endpoint to test whether a
 * challenge value ever existed.
 */
export async function pollStatus(challenge: string): Promise<ApprovalStatus | 'expired'> {
  const row = await queryOne<{ status: ApprovalStatus; expired: boolean }>(
    `SELECT status, (expires_at <= now()) AS expired
       FROM login_approvals
      WHERE challenge_hash = $1`,
    [sha256Hex(challenge)],
  );
  if (!row) return 'expired';
  if (row.status === 'pending' && row.expired) return 'expired';
  return row.status;
}

/**
 * Exchange an APPROVED request for the right to mint a session, once.
 *
 * The transition to 'consumed' happens in the same statement that authorises
 * it, so a challenge replayed from two tabs mints one session, not two. A
 * request that is pending, rejected, expired or already consumed returns null
 * and the caller issues nothing.
 */
export async function consume(challenge: string): Promise<{
  userId: string;
  device: { label: string | null; kind: string | null; ip: string | null; userAgent: string | null };
} | null> {
  const row = await queryOne<{
    user_id: string;
    device_label: string | null;
    device_kind: string | null;
    ip: string | null;
    user_agent: string | null;
  }>(
    `UPDATE login_approvals
        SET status = 'consumed', consumed_at = now()
      WHERE challenge_hash = $1
        AND status = 'approved'
        AND expires_at > now()
      RETURNING user_id, device_label, device_kind, ip, user_agent`,
    [sha256Hex(challenge)],
  );
  if (!row) return null;

  // THE DEVICE COMES BACK OUT WITH THE APPROVAL, and that is the point of
  // returning it rather than re-reading the collecting request's headers.
  //
  // Collect is a separate HTTP call from login. In a browser both come from the
  // same window so the User-Agent matches, but nothing enforces that — and the
  // value recorded here is the one shown in the session list, which the merchant
  // compares against the device named in the approval email. If those two ever
  // disagreed, the list would be describing a device that never asked for
  // anything, which is precisely the confusion a session list exists to prevent.
  return {
    userId: row.user_id,
    device: {
      label: row.device_label,
      kind: row.device_kind,
      ip: row.ip,
      userAgent: row.user_agent,
    },
  };
}

/**
 * Housekeeping. Pending rows that nobody answered are worthless once expired,
 * and decided ones are audit material with a shelf life. Called by the worker
 * alongside the other reapers; safe to run concurrently with itself.
 */
export async function reapExpiredApprovals(retainDays = 30): Promise<number> {
  // `RETURNING id` rather than a driver rowCount: db/pool's `query` resolves to
  // the ROWS, not to the pg result object, so counting the returned array is
  // the only accurate answer available through it.
  const rows = await query<{ id: string }>(
    `DELETE FROM login_approvals
      WHERE (status = 'pending' AND expires_at < now() - interval '1 day')
         OR (created_at < now() - ($1 || ' days')::interval)
      RETURNING id`,
    [String(retainDays)],
  );
  return rows.length;
}
