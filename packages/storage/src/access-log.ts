import type { DocumentId, ShareLinkId, TenantId } from "@inkly/domain";
import type { AccessDenied, AccessGranted } from "@inkly/domain/log";
import type { StorageEnv } from "./env.ts";

export interface AccessLogRow {
  action: string;
  resource: string;
  status: number;
  actorUserId: string;
  at: number;
  shareLinkId: string | null;
  ip: string | null;
  userAgent: string | null;
  documentId: string | null;
}

/** Appends a denied or granted access entry to the actor tenant's access log (append-only). */
export async function appendAccessLog(
  tenantId: TenantId,
  env: StorageEnv,
  entry: AccessDenied | AccessGranted,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO access_log (tenant_id, actor_user_id, action, resource, status, at, share_link_id, ip, user_agent, document_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      tenantId,
      entry.actorUserId,
      entry.action,
      entry.resource,
      entry.status,
      entry.at,
      entry.shareLinkId ?? null,
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.documentId ?? null,
    )
    .run();
}

export async function listAccessLog(tenantId: TenantId, env: StorageEnv): Promise<AccessLogRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT action, resource, status, actor_user_id AS actorUserId, at, share_link_id AS shareLinkId, ip, user_agent AS userAgent, document_id AS documentId FROM access_log WHERE tenant_id = ?1 ORDER BY id",
  )
    .bind(tenantId)
    .all<AccessLogRow>();
  return results;
}

export interface ActivityRow {
  id: number;
  at: number;
  action: string;
  status: number;
  actorUserId: string;
  /** The Member's name; null for Share-link visitors and Users no longer on record. */
  actorName: string | null;
  shareLinkId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * One page of a Document's (or one Share link's) activity, newest first, entries with
 * an id below `before`. A link visitor's content read is left out: the open already
 * records the view.
 */
export async function listActivity(
  tenantId: TenantId,
  env: StorageEnv,
  of: { documentId: DocumentId } | { shareLinkId: ShareLinkId },
  page: { before: number | null; limit: number },
): Promise<ActivityRow[]> {
  const column = "documentId" in of ? "l.document_id" : "l.share_link_id";
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.at, l.action, l.status, l.actor_user_id AS actorUserId, u.name AS actorName,
       l.share_link_id AS shareLinkId, l.ip, l.user_agent AS userAgent
     FROM access_log l LEFT JOIN users u ON l.share_link_id IS NULL AND u.id = l.actor_user_id
     WHERE l.tenant_id = ?1 AND ${column} = ?2 AND (?3 IS NULL OR l.id < ?3)
       AND NOT (l.share_link_id IS NOT NULL AND l.action = 'read-content' AND l.status = 200)
     ORDER BY l.id DESC LIMIT ?4`,
  )
    .bind(tenantId, "documentId" in of ? of.documentId : of.shareLinkId, page.before, page.limit)
    .all<ActivityRow>();
  return results;
}
