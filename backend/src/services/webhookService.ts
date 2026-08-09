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
 */
import { Job } from 'bullmq';
import { query, queryOne } from '../db/pool';
import { decrypt, hmacSha256 } from '../utils/crypto';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { webhookQueue } from '../workers/queues';

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

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO webhook_logs
       (client_id, payment_id, event, url, payload, signature, attempt, success)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, 1, false)
     RETURNING id`,
    [
      row.client_id,
      ctx.paymentId,
      ctx.event,
      row.webhook_url,
      JSON.stringify(payload),
      signature,
    ],
  );
  const webhookLogId = inserted!.id;

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
    });
    statusCode = res.status;
    responseBody = (await res.text()).slice(0, 4000);
    success = res.status >= 200 && res.status < 300;
  } catch (err) {
    responseBody = err instanceof Error ? err.message.slice(0, 4000) : 'request failed';
  } finally {
    clearTimeout(timer);
  }

  const nextRetryAt =
    !success && attempt < config.webhook.maxRetries
      ? new Date(Date.now() + Math.min(2 ** attempt, 3600) * 1000).toISOString()
      : null;

  // Record this attempt. attempt 1 already exists (enqueue); update it, insert
  // a new row for subsequent attempts so history is preserved.
  if (attempt === 1) {
    await query(
      `UPDATE webhook_logs
          SET status_code = $2, success = $3, response_body = $4,
              attempt = 1, next_retry_at = $5
        WHERE id = $1`,
      [webhookLogId, statusCode || null, success, responseBody, nextRetryAt],
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
      [webhookLogId, attempt, statusCode || null, success, responseBody, nextRetryAt],
    );
  }

  if (!success) {
    throw new Error(
      `webhook delivery failed (attempt ${attempt}, status ${statusCode}): ${responseBody}`,
    );
  }

  logger.info({ webhookLogId, attempt, statusCode }, 'webhook delivered');
}
