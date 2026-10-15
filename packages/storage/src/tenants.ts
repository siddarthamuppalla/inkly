import type { TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

export interface TenantRow {
  id: TenantId;
  name: string;
  plan: "free" | "pro";
  region: string;
  createdAt: number;
}

export async function createTenant(
  tenantId: TenantId,
  env: StorageEnv,
  name: string,
): Promise<void> {
  await env.DB.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?1, ?2, ?3)")
    .bind(tenantId, name, Date.now())
    .run();
}

export async function getTenant(tenantId: TenantId, env: StorageEnv): Promise<TenantRow | null> {
  const row = await env.DB.prepare(
    "SELECT id, name, plan, region, created_at AS createdAt FROM tenants WHERE id = ?1",
  )
    .bind(tenantId)
    .first<TenantRow>();
  return row;
}
