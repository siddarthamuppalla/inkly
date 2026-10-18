import {
  canonicalJson,
  type AuditEvent,
  type DocumentId,
  type EnvelopeId,
  type EnvelopeStatus,
  type FieldId,
  type FieldKind,
  type OrderMode,
  type RecipientId,
  type RecipientRole,
  type RecipientStatus,
  type TenantId,
  type UserId,
} from "@inkly/domain";
import type { StorageEnv } from "./env.ts";
import { usagePeriod } from "./usage.ts";

// `@inkly/storage/envelopes`: every write to envelopes, recipients, fields and audit_events,
// plus the Envelope Usage claim. Lint lets only the Envelope Durable Object import this, so
// it is the single writer of each Envelope (ADR-0006). Each call is one D1 batch, so a
// state change and the audit events that record it land together or not at all.

export interface NewEnvelope {
  id: EnvelopeId;
  documentId: DocumentId;
  version: number;
  title: string;
  createdBy: UserId;
  at: number;
}

export interface DraftSettings {
  title: string;
  message: string;
  orderMode: OrderMode;
  expiresInDays: number;
}

export interface NewRecipient {
  id: RecipientId;
  name: string;
  email: string;
  role: RecipientRole;
  routingOrder: number;
}

export interface NewField {
  id: FieldId;
  recipientId: RecipientId;
  kind: FieldKind;
  page: number;
  rect: { x: number; y: number; w: number; h: number };
  required: boolean;
}

export interface EnvelopePatch {
  status?: EnvelopeStatus;
  sentAt?: number;
  expiresAt?: number;
  completedAt?: number;
  finalVersion?: number;
}

export interface RecipientPatch {
  status?: RecipientStatus;
  tokenHash?: string | null;
  notifiedAt?: number;
  viewedAt?: number;
  signedAt?: number;
  declinedAt?: number;
  declineReason?: string;
  codeHash?: string | null;
  codeExpiresAt?: number | null;
  codeAttempts?: number;
  verifiedIp?: string | null;
  verifiedUserAgent?: string | null;
}

/** One state change of an Envelope and the audit events that record it. */
export interface EnvelopeChange {
  at: number;
  envelope?: EnvelopePatch;
  recipients?: readonly { id: RecipientId; patch: RecipientPatch }[];
  fields?: readonly { id: FieldId; value: string | null }[];
  events: readonly AuditEvent[];
}

const ENVELOPE_COLUMNS: Record<keyof EnvelopePatch, string> = {
  status: "status",
  sentAt: "sent_at",
  expiresAt: "expires_at",
  completedAt: "completed_at",
  finalVersion: "final_version",
};

const RECIPIENT_COLUMNS: Record<keyof RecipientPatch, string> = {
  status: "status",
  tokenHash: "token_hash",
  notifiedAt: "notified_at",
  viewedAt: "viewed_at",
  signedAt: "signed_at",
  declinedAt: "declined_at",
  declineReason: "decline_reason",
  codeHash: "code_hash",
  codeExpiresAt: "code_expires_at",
  codeAttempts: "code_attempts",
  verifiedIp: "verified_ip",
  verifiedUserAgent: "verified_user_agent",
};

/** `SET a = ?4, b = ?5` for the patch's present keys, numbered after `first - 1` binds. */
function assignments<P extends object>(
  patch: P,
  columns: Record<keyof P, string>,
  first: number,
): { sql: string; values: unknown[] } {
  const entries = (Object.keys(patch) as (keyof P)[]).filter((k) => patch[k] !== undefined);
  return {
    sql: entries.map((k, i) => `${columns[k]} = ?${String(first + i)}`).join(", "),
    values: entries.map((k) => patch[k]),
  };
}

function insertEvents(
  env: StorageEnv,
  tenantId: TenantId,
  events: readonly AuditEvent[],
): D1PreparedStatement[] {
  return events.map((e) => {
    if (e.tenantId !== tenantId) throw new Error("audit event for another tenant");
    return env.DB.prepare(
      `INSERT INTO audit_events (tenant_id, subject_type, subject_id, seq, actor, action, detail, ip, user_agent, at, prev_hash, hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      tenantId,
      e.subjectType,
      e.subjectId,
      e.seq,
      e.actor,
      e.action,
      canonicalJson(e.detail),
      e.ip,
      e.userAgent,
      e.at,
      e.prevHash,
      e.hash,
    );
  });
}

export async function insertEnvelope(
  tenantId: TenantId,
  env: StorageEnv,
  envelope: NewEnvelope,
  events: readonly AuditEvent[],
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO envelopes (tenant_id, id, document_id, version, title, status, order_mode, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'draft', 'parallel', ?6, ?7, ?7)`,
    ).bind(
      tenantId,
      envelope.id,
      envelope.documentId,
      envelope.version,
      envelope.title,
      envelope.createdBy,
      envelope.at,
    ),
    ...insertEvents(env, tenantId, events),
  ]);
}

/** Replaces a draft's settings, Recipients and Fields. False when it is no longer a draft. */
export async function replaceDraft(
  tenantId: TenantId,
  env: StorageEnv,
  id: EnvelopeId,
  at: number,
  settings: DraftSettings,
  recipients: readonly NewRecipient[],
  fields: readonly NewField[],
): Promise<boolean> {
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE envelopes SET title = ?3, message = ?4, order_mode = ?5, expires_in_days = ?6, updated_at = ?7
       WHERE tenant_id = ?1 AND id = ?2 AND status = 'draft'`,
    ).bind(
      tenantId,
      id,
      settings.title,
      settings.message,
      settings.orderMode,
      settings.expiresInDays,
      at,
    ),
    env.DB.prepare("DELETE FROM fields WHERE tenant_id = ?1 AND envelope_id = ?2").bind(
      tenantId,
      id,
    ),
    env.DB.prepare("DELETE FROM recipients WHERE tenant_id = ?1 AND envelope_id = ?2").bind(
      tenantId,
      id,
    ),
    ...recipients.map((r) =>
      env.DB.prepare(
        `INSERT INTO recipients (tenant_id, envelope_id, id, email, name, role, routing_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(tenantId, id, r.id, r.email, r.name, r.role, r.routingOrder),
    ),
    ...fields.map((f) =>
      env.DB.prepare(
        `INSERT INTO fields (tenant_id, envelope_id, id, recipient_id, kind, page, x, y, w, h, required)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        tenantId,
        id,
        f.id,
        f.recipientId,
        f.kind,
        f.page,
        f.rect.x,
        f.rect.y,
        f.rect.w,
        f.rect.h,
        f.required ? 1 : 0,
      ),
    ),
  ]);
  return (updated?.meta.changes ?? 0) > 0;
}

/** Deletes a draft with its Recipients and Fields; its audit events stay. */
export async function deleteDraft(
  tenantId: TenantId,
  env: StorageEnv,
  id: EnvelopeId,
): Promise<void> {
  const draft =
    "AND EXISTS (SELECT 1 FROM envelopes WHERE tenant_id = ?1 AND id = ?2 AND status = 'draft')";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM fields WHERE tenant_id = ?1 AND envelope_id = ?2 ${draft}`).bind(
      tenantId,
      id,
    ),
    env.DB.prepare(
      `DELETE FROM recipients WHERE tenant_id = ?1 AND envelope_id = ?2 ${draft}`,
    ).bind(tenantId, id),
    env.DB.prepare(
      "DELETE FROM envelopes WHERE tenant_id = ?1 AND id = ?2 AND status = 'draft'",
    ).bind(tenantId, id),
  ]);
}

/** Applies one Envelope state change and appends its audit events, atomically. */
export async function commitEnvelope(
  tenantId: TenantId,
  env: StorageEnv,
  id: EnvelopeId,
  change: EnvelopeChange,
): Promise<void> {
  const envelope = assignments(change.envelope ?? {}, ENVELOPE_COLUMNS, 4);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE envelopes SET updated_at = ?3${envelope.sql ? `, ${envelope.sql}` : ""}
       WHERE tenant_id = ?1 AND id = ?2`,
    ).bind(tenantId, id, change.at, ...envelope.values),
  ];
  for (const { id: recipientId, patch } of change.recipients ?? []) {
    const set = assignments(patch, RECIPIENT_COLUMNS, 4);
    if (!set.sql) continue;
    statements.push(
      env.DB.prepare(
        `UPDATE recipients SET ${set.sql} WHERE tenant_id = ?1 AND envelope_id = ?2 AND id = ?3`,
      ).bind(tenantId, id, recipientId, ...set.values),
    );
  }
  for (const field of change.fields ?? []) {
    statements.push(
      env.DB.prepare(
        "UPDATE fields SET value = ?4 WHERE tenant_id = ?1 AND envelope_id = ?2 AND id = ?3",
      ).bind(tenantId, id, field.id, field.value),
    );
  }
  await env.DB.batch([...statements, ...insertEvents(env, tenantId, change.events)]);
}

/**
 * Counts one sent Envelope against this period's Usage if fewer than `max` are used;
 * atomic, so concurrent sends cannot overshoot. False means the Limit is reached.
 */
export async function claimEnvelope(
  tenantId: TenantId,
  env: StorageEnv,
  max: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO usage (tenant_id, period, envelopes) VALUES (?1, ?2, 1)
     ON CONFLICT (tenant_id, period) DO UPDATE SET envelopes = envelopes + 1
       WHERE usage.envelopes < ?3
     RETURNING envelopes`,
  )
    .bind(tenantId, usagePeriod(Date.now()), max)
    .first<{ envelopes: number }>();
  return row !== null;
}

/** Gives back an Envelope claimed this period whose send did not happen. */
export async function releaseEnvelope(tenantId: TenantId, env: StorageEnv): Promise<void> {
  await env.DB.prepare(
    "UPDATE usage SET envelopes = MAX(envelopes - 1, 0) WHERE tenant_id = ?1 AND period = ?2",
  )
    .bind(tenantId, usagePeriod(Date.now()))
    .run();
}
