import type { TenantId, UserId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

export interface UserRow {
  id: UserId;
  tenantId: TenantId;
  email: string;
  createdAt: number;
}

export async function createUser(
  tenantId: TenantId,
  env: StorageEnv,
  user: { id: UserId; email: string },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, tenant_id, email, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(user.id, tenantId, user.email, Date.now())
    .run();
}

export async function getUser(
  tenantId: TenantId,
  env: StorageEnv,
  userId: UserId,
): Promise<UserRow | null> {
  return env.DB.prepare(
    "SELECT id, tenant_id AS tenantId, email, created_at AS createdAt FROM users WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, userId)
    .first<UserRow>();
}
