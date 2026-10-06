import type { Queryable } from "./db.js";

export interface AuditEntry {
  actorUserId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

// Pass the transaction client so the audit row commits or rolls back with the change it describes.
export async function writeAudit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into audit_logs (actor_user_id, action, entity, entity_id, old_value, new_value, ip, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actorUserId,
      e.action,
      e.entity,
      e.entityId ?? null,
      e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
      e.newValue === undefined ? null : JSON.stringify(e.newValue),
      e.ip ?? null,
      e.requestId ?? null,
    ],
  );
}
