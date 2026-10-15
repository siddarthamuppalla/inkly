import type { TenantId, UserId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

export interface MemberRow {
  userId: UserId;
  email: string;
  name: string;
  role: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

export async function listMembers(tenantId: TenantId, env: StorageEnv): Promise<MemberRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT u.id AS userId, u.email AS email, u.name AS name, m.role AS role FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ?1 ORDER BY m.created_at, m.id",
  )
    .bind(tenantId)
    .all<MemberRow>();
  return results;
}

/** Invitations still waiting for an answer and not yet expired. */
export async function listPendingInvitations(
  tenantId: TenantId,
  env: StorageEnv,
): Promise<InvitationRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, email, role, expires_at AS expiresAt FROM invitations WHERE tenant_id = ?1 AND status = 'pending' AND expires_at > ?2 ORDER BY created_at, id",
  )
    .bind(tenantId, new Date().toISOString())
    .all<InvitationRow>();
  return results;
}
