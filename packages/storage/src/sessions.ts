import type { TenantId, UserId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

export interface SessionRow {
  tenantId: TenantId;
  userId: UserId;
  expiresAt: number;
}

export async function createSession(
  tenantId: TenantId,
  env: StorageEnv,
  session: { tokenHash: string; userId: UserId; expiresAt: number },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, tenant_id, user_id, expires_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(session.tokenHash, tenantId, session.userId, session.expiresAt)
    .run();
}

/**
 * The one lookup that is not TenantId-first: it is how `packages/auth` learns the
 * caller's tenant from a session token hash. Expired sessions are not returned.
 */
export async function findSession(env: StorageEnv, tokenHash: string): Promise<SessionRow | null> {
  return env.DB.prepare(
    "SELECT tenant_id AS tenantId, user_id AS userId, expires_at AS expiresAt FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
  )
    .bind(tokenHash, Date.now())
    .first<SessionRow>();
}
