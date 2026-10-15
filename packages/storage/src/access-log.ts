import type { TenantId } from "@inkly/domain";
import type { AccessDenied } from "@inkly/domain/log";
import type { StorageEnv } from "./env.ts";

export interface AccessLogRow {
  action: string;
  resource: string;
  status: number;
  actorUserId: string;
  at: number;
}

/** Appends a denied-access entry to the actor tenant's access log (append-only). */
export async function appendAccessLog(
  tenantId: TenantId,
  env: StorageEnv,
  entry: AccessDenied,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO access_log (tenant_id, actor_user_id, action, resource, status, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(tenantId, entry.actorUserId, entry.action, entry.resource, entry.status, entry.at)
    .run();
}

export async function listAccessLog(tenantId: TenantId, env: StorageEnv): Promise<AccessLogRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT action, resource, status, actor_user_id AS actorUserId, at FROM access_log WHERE tenant_id = ?1 ORDER BY id",
  )
    .bind(tenantId)
    .all<AccessLogRow>();
  return results;
}
