/**
 * Status enum mapping between the DB schema and the two React panels.
 *
 * The DB is the storage source of truth; the panels each have their own enum
 * vocabulary. We MAP at the API boundary only (never mutate the DB schema).
 *
 *   payment status: identical on both sides — pass through.
 *
 *   payout status DB(pending|processing|sent|confirmed|failed)
 *     -> client-panel(queued|processing|sent|confirmed|failed): pending -> queued
 *     -> admin-panel (queued|processing|sent|failed):           pending -> queued,
 *                                                               confirmed -> sent
 *
 *   client status DB(pending|approved|suspended|rejected)
 *     -> admin-panel Client.status(pending|active|suspended|rejected): approved -> active
 */

/** Payment status is identical in the DB and both panels — pass through. */
export function mapPaymentStatus(dbStatus: string): string {
  return dbStatus;
}

/**
 * DB payout status -> client-panel PayoutStatus
 * (queued|processing|sent|confirmed|failed). Only `pending` differs.
 */
export function mapPayoutStatusClient(dbStatus: string): string {
  return dbStatus === 'pending' ? 'queued' : dbStatus;
}

/**
 * DB payout status -> admin-panel PayoutStatus (queued|processing|sent|failed).
 * `pending` -> queued; `confirmed` -> sent (admin panel has no `confirmed`).
 */
export function mapPayoutStatusAdmin(dbStatus: string): string {
  if (dbStatus === 'pending') return 'queued';
  if (dbStatus === 'confirmed') return 'sent';
  return dbStatus;
}

/**
 * DB client status -> admin-panel Client.status
 * (pending|active|suspended|rejected). `approved` -> active.
 */
export function mapClientStatus(dbStatus: string): string {
  return dbStatus === 'approved' ? 'active' : dbStatus;
}

/**
 * Inverse of mapClientStatus for query filters: the admin panel may send
 * `active` in a status filter, meaning DB `approved`.
 */
export function unmapClientStatus(panelStatus: string): string {
  return panelStatus === 'active' ? 'approved' : panelStatus;
}
