/**
 * Audit trail writer. Every privileged mutation (client approve/suspend,
 * commission change, manual payout, key regeneration) should call writeAudit.
 */
import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logger } from '../config/logger';

export interface AuditInput {
  actorUserId?: string | null;
  actorType?: 'user' | 'system' | 'api';
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function writeAudit(
  input: AuditInput,
  client?: PoolClient,
): Promise<void> {
  const sql = `
    INSERT INTO audit_logs
      (actor_user_id, actor_type, action, entity_type, entity_id, metadata, ip)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `;
  const params = [
    input.actorUserId ?? null,
    input.actorType ?? 'user',
    input.action,
    input.entityType ?? null,
    input.entityId ?? null,
    JSON.stringify(input.metadata ?? {}),
    input.ip ?? null,
  ];
  try {
    if (client) {
      await client.query(sql, params);
    } else {
      await pool.query(sql, params);
    }
  } catch (err) {
    // Auditing must never break the primary operation; log and continue.
    logger.error({ err, action: input.action }, 'failed to write audit log');
  }
}
