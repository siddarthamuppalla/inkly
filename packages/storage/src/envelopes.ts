import type {
  AuditAction,
  AuditEvent,
  AuditSubjectType,
  DocumentId,
  EnvelopeId,
  EnvelopeStatus,
  FieldId,
  FieldKind,
  JsonValue,
  OrderMode,
  RecipientId,
  RecipientRole,
  RecipientStatus,
  TenantId,
  UserId,
} from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

// T3.1 Envelope reads. Every Member path reads through these; the writes live in
// `@inkly/storage/envelopes`, which only the Envelope Durable Object imports (ADR-0006).
// Token and code hashes never leave storage through these rows.

export interface EnvelopeRow {
  id: EnvelopeId;
  documentId: DocumentId;
  version: number;
  title: string;
  message: string;
  status: EnvelopeStatus;
  orderMode: OrderMode;
  expiresInDays: number;
  createdBy: UserId;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
  expiresAt: number | null;
  completedAt: number | null;
  finalVersion: number | null;
}

export interface RecipientRow {
  id: RecipientId;
  name: string;
  email: string;
  role: RecipientRole;
  routingOrder: number;
  status: RecipientStatus;
  notifiedAt: number | null;
  viewedAt: number | null;
  signedAt: number | null;
  declinedAt: number | null;
  declineReason: string | null;
}

export interface FieldRow {
  id: FieldId;
  recipientId: RecipientId;
  kind: FieldKind;
  page: number;
  rect: { x: number; y: number; w: number; h: number };
  required: boolean;
  value: string | null;
}

const ENVELOPE_SELECT = `SELECT id, document_id AS documentId, version, title, message, status,
  order_mode AS orderMode, expires_in_days AS expiresInDays, created_by AS createdBy,
  created_at AS createdAt, updated_at AS updatedAt, sent_at AS sentAt, expires_at AS expiresAt,
  completed_at AS completedAt, final_version AS finalVersion
  FROM envelopes`;

const RECIPIENT_SELECT = `SELECT id, name, email, role, routing_order AS routingOrder, status,
  notified_at AS notifiedAt, viewed_at AS viewedAt, signed_at AS signedAt,
  declined_at AS declinedAt, decline_reason AS declineReason
  FROM recipients`;

export async function getEnvelope(
  tenantId: TenantId,
  env: StorageEnv,
  id: EnvelopeId,
): Promise<EnvelopeRow | null> {
  return env.DB.prepare(`${ENVELOPE_SELECT} WHERE tenant_id = ?1 AND id = ?2`)
    .bind(tenantId, id)
    .first<EnvelopeRow>();
}

/** The Tenant's Envelopes, optionally in one status; most recently changed first. */
export async function listEnvelopes(
  tenantId: TenantId,
  env: StorageEnv,
  where: { status?: EnvelopeStatus } = {},
): Promise<EnvelopeRow[]> {
  const query =
    where.status === undefined
      ? env.DB.prepare(
          `${ENVELOPE_SELECT} WHERE tenant_id = ?1 ORDER BY updated_at DESC, id LIMIT 500`,
        ).bind(tenantId)
      : env.DB.prepare(
          `${ENVELOPE_SELECT} WHERE tenant_id = ?1 AND status = ?2 ORDER BY updated_at DESC, id LIMIT 500`,
        ).bind(tenantId, where.status);
  return (await query.all<EnvelopeRow>()).results;
}

/** An Envelope's Recipients in routing order, then as they were added. */
export async function listRecipients(
  tenantId: TenantId,
  env: StorageEnv,
  envelopeId: EnvelopeId,
): Promise<RecipientRow[]> {
  const { results } = await env.DB.prepare(
    `${RECIPIENT_SELECT} WHERE tenant_id = ?1 AND envelope_id = ?2 ORDER BY routing_order, rowid`,
  )
    .bind(tenantId, envelopeId)
    .all<RecipientRow>();
  return results;
}

type RawField = Omit<FieldRow, "rect" | "required"> & {
  x: number;
  y: number;
  w: number;
  h: number;
  required: number;
};

/** An Envelope's Fields in page order, then top to bottom. */
export async function listFields(
  tenantId: TenantId,
  env: StorageEnv,
  envelopeId: EnvelopeId,
): Promise<FieldRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, recipient_id AS recipientId, kind, page, x, y, w, h, required, value
     FROM fields WHERE tenant_id = ?1 AND envelope_id = ?2 ORDER BY page, y, x, rowid`,
  )
    .bind(tenantId, envelopeId)
    .all<RawField>();
  return results.map(({ x, y, w, h, required, ...field }) => ({
    ...field,
    rect: { x, y, w, h },
    required: required === 1,
  }));
}

interface RawAuditEvent {
  seq: number;
  actor: string;
  action: AuditAction;
  detail: string;
  ip: string | null;
  userAgent: string | null;
  at: number;
  prevHash: string;
  hash: string;
}

/** A subject's audit trail in `seq` order. */
export async function listAuditEvents(
  tenantId: TenantId,
  env: StorageEnv,
  subjectType: AuditSubjectType,
  subjectId: string,
): Promise<AuditEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT seq, actor, action, detail, ip, user_agent AS userAgent, at,
       prev_hash AS prevHash, hash
     FROM audit_events WHERE tenant_id = ?1 AND subject_type = ?2 AND subject_id = ?3
     ORDER BY seq`,
  )
    .bind(tenantId, subjectType, subjectId)
    .all<RawAuditEvent>();
  return results.map((row) => ({
    ...row,
    tenantId,
    subjectType,
    subjectId,
    detail: JSON.parse(row.detail) as { [key: string]: JsonValue },
  }));
}

/** The last event of a subject's trail: where the next event chains on. */
export async function auditHead(
  tenantId: TenantId,
  env: StorageEnv,
  subjectType: AuditSubjectType,
  subjectId: string,
): Promise<{ seq: number; hash: string } | null> {
  return env.DB.prepare(
    `SELECT seq, hash FROM audit_events
     WHERE tenant_id = ?1 AND subject_type = ?2 AND subject_id = ?3 ORDER BY seq DESC LIMIT 1`,
  )
    .bind(tenantId, subjectType, subjectId)
    .first<{ seq: number; hash: string }>();
}
