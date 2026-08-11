/**
 * Webhook delivery service.
 *
 * enqueueWebhook: build the signed payload, write a webhook_logs row, enqueue a
 *   BullMQ job referencing that row.
 * dispatch: POST the payload with a timeout, record the attempt (status_code,
 *   success, response_body). On failure it throws so BullMQ retries with the
 *   queue's exponential backoff, up to WEBHOOK_MAX_RETRIES attempts.
 *
 * SIGNATURE: HMAC-SHA256 over the exact JSON body string, keyed by the client's
 * decrypted webhook_secret, hex-encoded — symmetric with the inbound merchant
 * scheme in middleware/auth.ts. The `signature` field is included INSIDE the body
 * per the OpenAPI webhook schema; it signs the body WITHOUT the signature field.
 *
 * ============================ SSRF: WHY THIS FILE IS GUARDED =================
 * `clients.webhook_url` is set by the MERCHANT and fetched by OUR worker, and
 * the response used to be stored in `webhook_logs.response_body` and handed
 * straight back to that same merchant through GET /account/webhook-logs. That
 * is a full read-SSRF with exfiltration: point the webhook at
 * http://127.0.0.1:4100/… or http://169.254.169.254/latest/meta-data/ and read
 * 4,000 characters of the answer from your own dashboard. The gateway ships
 * co-hosted with other apps on one box, so "internal" is not hypothetical.
 *
 * THREE CONTROLS, all of which have to stay:
 *   1. The destination is resolved through DNS and every returned address is
 *      checked against loopback / link-local / RFC1918 / CGNAT / multicast
 *      space, at ENQUEUE time and again immediately BEFORE the fetch. Checking
 *      only the configured string is bypassed by a hostname that resolves into
 *      private space, and checking only at configuration time is bypassed by
 *      re-pointing the DNS record afterwards.
 *   2. `redirect: 'manual'`. Without it a public host answering 302 walks us to
 *      any internal address of its choosing, and the fetch spec downgrades a
 *      redirected POST to GET — which is exactly the shape internal read
 *      endpoints expose. A redirect is never a valid webhook acknowledgement.
 *   3. The response body is NOT stored. Status code, byte length and a digest
 *      are enough to debug a delivery, and none of them carry the content of
 *      whatever was reached.
 *
 * WHAT IS STILL OPEN: the window between the last lookup and the socket
 * connecting (DNS rebinding). Closing it needs a pinned-IP dispatcher or, far
 * better, an egress policy on the worker — this file cannot be the only layer.
 */
import { Job } from 'bullmq';
import dns from 'dns';
import net from 'net';
import { query, queryOne } from '../db/pool';
import { decrypt, hmacSha256, sha256Hex } from '../utils/crypto';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { webhookQueue } from '../workers/queues';

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

/** The destination is not a legal webhook target. Permanent: never retry it. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
    Object.setPrototypeOf(this, SsrfBlockedError.prototype);
  }
}

/**
 * Everything a webhook must never reach. Loopback and link-local are the
 * headline (127.0.0.1 for the co-hosted apps, 169.254.169.254 for cloud
 * metadata), but RFC1918 and CGNAT matter just as much on a private network,
 * and the documentation ranges are here because they are routinely pointed at
 * internal hosts in split-horizon DNS.
 */
const BLOCKED_RANGES = new net.BlockList();
BLOCKED_RANGES.addSubnet('0.0.0.0', 8, 'ipv4'); // "this host on this network"
BLOCKED_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED_RANGES.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
BLOCKED_RANGES.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
BLOCKED_RANGES.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local / metadata
BLOCKED_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED_RANGES.addSubnet('192.0.0.0', 24, 'ipv4');
BLOCKED_RANGES.addSubnet('192.0.2.0', 24, 'ipv4');
BLOCKED_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
BLOCKED_RANGES.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
BLOCKED_RANGES.addSubnet('198.51.100.0', 24, 'ipv4');
BLOCKED_RANGES.addSubnet('203.0.113.0', 24, 'ipv4');
BLOCKED_RANGES.addSubnet('224.0.0.0', 4, 'ipv4'); // multicast
BLOCKED_RANGES.addSubnet('240.0.0.0', 4, 'ipv4'); // reserved + broadcast
BLOCKED_RANGES.addAddress('::', 'ipv6');
BLOCKED_RANGES.addAddress('::1', 'ipv6'); // loopback
BLOCKED_RANGES.addSubnet('fc00::', 7, 'ipv6'); // unique local
BLOCKED_RANGES.addSubnet('fe80::', 10, 'ipv6'); // link-local
BLOCKED_RANGES.addSubnet('ff00::', 8, 'ipv6'); // multicast
BLOCKED_RANGES.addSubnet('2001:db8::', 32, 'ipv6'); // documentation
BLOCKED_RANGES.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64

/** A hostile DNS server should not be able to stall the worker. */
const DNS_TIMEOUT_MS = 3_000;

function isBlockedAddress(address: string): boolean {
  let addr = address;
  let family: 'ipv4' | 'ipv6' = 'ipv6';

  // ::ffff:127.0.0.1 is 127.0.0.1 wearing a hat. Judge it as the IPv4 address
  // it embeds, or every v4 rule above is trivially bypassed.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) {
    addr = mapped[1];
    family = 'ipv4';
  } else if (net.isIPv4(addr)) {
    family = 'ipv4';
  }

  // Anything we cannot parse, we do not connect to.
  if (!net.isIP(addr)) return true;
  return BLOCKED_RANGES.check(addr, family);
}

async function resolveAll(hostname: string): Promise<string[]> {
  const lookup = dns.promises.lookup(hostname, { all: true, verbatim: true });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`DNS lookup for ${hostname} timed out`)),
      DNS_TIMEOUT_MS,
    ).unref(),
  );
  const results = await Promise.race([lookup, timeout]);
  return results.map((r) => r.address);
}

/**
 * Throws `SsrfBlockedError` if `raw` is not a public http(s) destination.
 *
 * Resolution failures throw a PLAIN Error instead, because "your DNS is down"
 * and "you pointed us at the metadata service" deserve opposite treatment: the
 * first is retryable, the second must never be retried.
 *
 * Exported so the write paths that accept a webhook_url — routes/account.ts
 * (PUT /account/settings) and routes/admin.ts — can reject a bad URL at
 * configuration time with a clear message instead of silently never delivering.
 * Validating there is NOT a substitute for validating here: rows predating the
 * validator are already in the table, and DNS can be re-pointed afterwards.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('webhook_url is not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `webhook_url scheme '${url.protocol}' is not allowed (use http or https)`,
    );
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError('webhook_url must not embed credentials');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await resolveAll(hostname);
  if (addresses.length === 0) {
    throw new Error(`webhook host ${hostname} did not resolve`);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new SsrfBlockedError(
        `webhook host ${hostname} resolves to a non-public address (${address})`,
      );
    }
  }
  return url;
}

export interface WebhookPayload {
  event: string;
  paymentId: string;
  orderId: string;
  amount: string;
  txHash: string | null;
  status: string;
  signature: string;
}

/**
 * THE ONE PLACE that decides the byte layout of a webhook body.
 *
 * Both signing and delivery go through here, because the signature is over a
 * JSON *string* and JSON.stringify emits keys in insertion order — so the
 * signed bytes and the delivered bytes are only equal if both are built the
 * same way. They were not.
 *
 * The bug this exists to prevent: the payload is persisted to `webhook_logs`
 * as `jsonb`, and jsonb does NOT preserve key order — it normalises keys by
 * (length, then bytewise). Delivery used to re-`JSON.stringify` the row read
 * back from that column, so the wire body came out as
 *   event, amount, status, txHash, orderId, paymentId, signature
 * while the signature had been computed over
 *   event, paymentId, orderId, amount, txHash, status, signature
 * Different bytes, same secret — so every documented receiver (which rebuilds
 * the body with `signature` blanked and re-serialises) computed a different
 * digest and rejected every delivery as forged.
 *
 * Never build a webhook body any other way, and never round-trip it through
 * jsonb on the way to the wire. The stored `payload` column is for the log
 * viewer; this function is for the network.
 */
export function canonicalBody(payload: WebhookPayload, signature: string): string {
  return JSON.stringify({
    event: payload.event,
    paymentId: payload.paymentId,
    orderId: payload.orderId,
    amount: payload.amount,
    txHash: payload.txHash,
    status: payload.status,
    signature,
  });
}

interface EnqueueContext {
  paymentId: string;
  event: string; // e.g. 'payment.created', 'payment.confirming', 'payout.completed'
  // Optional overrides for events whose payload differs from the live payment row
  // (e.g. payout.completed carries the payout tx hash, not the deposit tx).
  overrides?: { txHash?: string | null; status?: string; amount?: string };
}

/**
 * Build + persist + enqueue a webhook for a payment event.
 * No-op (returns null) if the client has no webhook_url configured.
 */
export async function enqueueWebhook(
  ctx: EnqueueContext,
): Promise<string | null> {
  const row = await queryOne<{
    client_id: string;
    order_id: string;
    amount_received: string;
    amount: string;
    status: string;
    tx_hash: string | null;
    webhook_url: string | null;
    webhook_secret: string | null;
  }>(
    `SELECT p.client_id,
            p.order_id,
            p.amount_received,
            p.amount,
            p.status,
            p.tx_hash,
            c.webhook_url,
            c.webhook_secret
       FROM payments p
       JOIN clients  c ON c.id = p.client_id
      WHERE p.id = $1`,
    [ctx.paymentId],
  );

  if (!row) {
    logger.warn({ paymentId: ctx.paymentId }, 'enqueueWebhook: payment not found');
    return null;
  }
  if (!row.webhook_url) {
    logger.info({ paymentId: ctx.paymentId }, 'client has no webhook_url; skipping');
    return null;
  }

  const secret = row.webhook_secret ? decrypt(row.webhook_secret) : '';

  // CANONICAL SIGNED FORM — must stay byte-for-byte in sync with the SDK
  // receivers in docs/sdk/*.md. The signature covers the FULL payload with the
  // `signature` field present but set to the empty string "", serialized in the
  // key order fixed by canonicalBody() (compact, no spaces). Receivers verify by
  // taking the delivered body, setting `signature` back to "", and
  // re-serializing. We intentionally include the (empty) signature key rather
  // than omitting it, so parse -> blank -> re-stringify round-trips exactly.
  const canonical: WebhookPayload = {
    event: ctx.event,
    paymentId: ctx.paymentId,
    orderId: row.order_id,
    // Show what was actually received once any funds arrive, else the invoice
    // amount. NUMERIC comes back as '0.000000000000000000', so compare as a
    // number — a string `!== '0'` check is always true and wrongly reports 0.
    amount:
      ctx.overrides?.amount ??
      (Number(row.amount_received) > 0 ? row.amount_received : row.amount),
    txHash:
      ctx.overrides?.txHash !== undefined ? ctx.overrides.txHash : row.tx_hash,
    status: ctx.overrides?.status ?? row.status,
    signature: '',
  };
  const signature = secret ? hmacSha256(secret, canonicalBody(canonical, '')) : '';
  // Fill the real signature in. Delivery rebuilds the body through the same
  // canonicalBody(), so the wire bytes are the signed bytes with only the
  // signature VALUE swapped — which is exactly what receivers assume.
  const payload: WebhookPayload = { ...canonical, signature };

  // Refuse a non-public destination before it ever becomes a job.
  //
  // Fail CLOSED only when the name RESOLVES into blocked space; a DNS error is
  // transient and must not drop a webhook, so we enqueue anyway and let
  // dispatch (which re-checks) retry it on the queue's backoff.
  let blockedReason: string | null = null;
  try {
    await assertPublicHttpUrl(row.webhook_url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      blockedReason = err.message;
    } else {
      logger.warn(
        { err, paymentId: ctx.paymentId, clientId: row.client_id },
        'could not resolve webhook_url at enqueue time; enqueuing anyway',
      );
    }
  }

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO webhook_logs
       (client_id, payment_id, event, url, payload, signature, attempt, success,
        response_body)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, false, $7)
     RETURNING id`,
    [
      row.client_id,
      ctx.paymentId,
      ctx.event,
      row.webhook_url,
      JSON.stringify(payload),
      signature,
      blockedReason ? `blocked before sending: ${blockedReason}` : null,
    ],
  );
  const webhookLogId = inserted!.id;

  if (blockedReason) {
    // The row above is what picks this up: it is exactly what the merchant sees
    // in Settings -> Webhook logs and what an operator sees in the admin view,
    // marked failed with the reason, so a misconfigured URL is visible rather
    // than silently swallowed. No job is queued: retrying a blocked address can
    // only ever fail, and the merchant's own remedy is to fix the URL, after
    // which the NEXT event delivers normally. Payment state does not depend on
    // webhook delivery — the merchant can also poll GET /payments/{id}.
    logger.error(
      { paymentId: ctx.paymentId, clientId: row.client_id, webhookLogId, blockedReason },
      'refused to deliver webhook: destination is not a public address',
    );
    return null;
  }

  await webhookQueue.add('deliver', { webhookLogId });
  return webhookLogId;
}

/**
 * BullMQ processor: deliver one webhook_logs row.
 * Records the attempt number (from job.attemptsMade) and result. Throws on any
 * non-2xx or network error so BullMQ schedules the next backoff attempt.
 */
export async function dispatch(job: Job<{ webhookLogId: string }>): Promise<void> {
  const { webhookLogId } = job.data;

  const log = await queryOne<{
    id: string;
    url: string;
    payload: unknown;
    signature: string;
  }>(`SELECT id, url, payload, signature FROM webhook_logs WHERE id = $1`, [
    webhookLogId,
  ]);
  if (!log) {
    logger.warn({ webhookLogId }, 'dispatch: webhook_logs row missing');
    return;
  }

  const attempt = job.attemptsMade + 1;
  // Rebuild through canonicalBody() rather than stringifying the row straight
  // from the DB: `payload` is jsonb and comes back with its keys reordered, so
  // stringifying it directly would put bytes on the wire that the stored
  // signature was never computed over. See canonicalBody().
  const bodyStr = canonicalBody(log.payload as WebhookPayload, log.signature);

  // Re-check the destination immediately before connecting, not just when it
  // was configured: the row may predate the guard, and DNS can be re-pointed at
  // any time. A resolution FAILURE is not a block — it falls through to the
  // fetch, which fails and retries on the queue's backoff as before.
  try {
    await assertPublicHttpUrl(log.url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      logger.error(
        { webhookLogId, attempt, url: log.url, reason: err.message },
        'refused to deliver webhook: destination is not a public address',
      );
      // Recorded as a failed attempt with no next_retry_at, and NOT thrown:
      // throwing would burn all WEBHOOK_MAX_RETRIES attempts against an address
      // we will never be willing to connect to. The merchant sees the reason in
      // their webhook log and fixes the URL; the next event delivers normally.
      await recordAttempt(webhookLogId, attempt, null, false, {
        responseBody: `blocked before sending: ${err.message}`,
        nextRetryAt: null,
      });
      return;
    }
    logger.warn({ err, webhookLogId }, 'webhook host lookup failed; attempting anyway');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webhook.timeoutMs);

  let statusCode = 0;
  let responseBody = '';
  let success = false;

  try {
    const res = await fetch(log.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-gateway-signature': log.signature,
        'x-gateway-event': String((log.payload as { event?: string }).event ?? ''),
      },
      body: bodyStr,
      signal: controller.signal,
      // Do NOT follow redirects. A public host answering 302 would otherwise
      // walk us to any internal address it likes, and the fetch spec turns the
      // redirected POST into a GET — precisely the shape internal read
      // endpoints expose. A redirect is never a valid webhook acknowledgement.
      redirect: 'manual',
    });
    statusCode = res.status;
    const raw = await res.text();
    success = res.status >= 200 && res.status < 300;
    // The RESPONSE BODY IS NOT STORED. It used to be, 4,000 characters of it,
    // readable by the merchant through GET /account/webhook-logs — which is
    // what turned a server-side fetch into an exfiltration channel. Status,
    // length and a digest are enough to tell two responses apart when debugging
    // and carry none of the content.
    responseBody = describeResponse(res.status, raw);
    if (res.status >= 300 && res.status < 400) {
      responseBody += ' — redirects are not followed; point webhook_url at the final URL';
    }
  } catch (err) {
    // Our own error text, not the target's — safe to keep verbatim.
    responseBody = err instanceof Error ? err.message.slice(0, 500) : 'request failed';
  } finally {
    clearTimeout(timer);
  }

  const nextRetryAt =
    !success && attempt < config.webhook.maxRetries
      ? new Date(Date.now() + Math.min(2 ** attempt, 3600) * 1000).toISOString()
      : null;

  await recordAttempt(webhookLogId, attempt, statusCode || null, success, {
    responseBody,
    nextRetryAt,
  });

  if (!success) {
    throw new Error(
      `webhook delivery failed (attempt ${attempt}, status ${statusCode}): ${responseBody}`,
    );
  }

  logger.info({ webhookLogId, attempt, statusCode }, 'webhook delivered');
}

/** Status + size + digest. Never the bytes themselves. */
function describeResponse(status: number, raw: string): string {
  const bytes = Buffer.byteLength(raw, 'utf8');
  const digest = bytes > 0 ? sha256Hex(raw).slice(0, 16) : 'empty';
  return `HTTP ${status}; ${bytes} bytes; sha256:${digest} (body not stored)`;
}

/**
 * Record one delivery attempt. Attempt 1's row already exists (enqueue) and is
 * updated in place; later attempts insert a new row so the history is kept.
 * Unchanged in shape from the original inline version — only lifted out so the
 * blocked-destination path can record a failure without duplicating it.
 */
async function recordAttempt(
  webhookLogId: string,
  attempt: number,
  statusCode: number | null,
  success: boolean,
  extra: { responseBody: string; nextRetryAt: string | null },
): Promise<void> {
  if (attempt === 1) {
    await query(
      `UPDATE webhook_logs
          SET status_code = $2, success = $3, response_body = $4,
              attempt = 1, next_retry_at = $5
        WHERE id = $1`,
      [webhookLogId, statusCode, success, extra.responseBody, extra.nextRetryAt],
    );
  } else {
    // Preserve the original row's client/payment/url via a self-referencing insert.
    await query(
      `INSERT INTO webhook_logs
         (client_id, payment_id, event, url, payload, signature, attempt,
          status_code, success, response_body, next_retry_at)
       SELECT client_id, payment_id, event, url, payload, signature, $2,
              $3, $4, $5, $6
         FROM webhook_logs WHERE id = $1`,
      [webhookLogId, attempt, statusCode, success, extra.responseBody, extra.nextRetryAt],
    );
  }
}
