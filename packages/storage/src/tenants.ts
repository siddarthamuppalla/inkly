import type { TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

// Tenants are created by Better-Auth's organization plugin through `packages/auth`;
// this module reads them and changes the fields Inkly owns.

export type Plan = "free" | "pro";

export interface TenantRow {
  id: TenantId;
  name: string;
  plan: Plan;
  region: string;
  createdAt: string;
}

export async function getTenant(tenantId: TenantId, env: StorageEnv): Promise<TenantRow | null> {
  return env.DB.prepare(
    "SELECT id, name, plan, region, created_at AS createdAt FROM tenants WHERE id = ?1",
  )
    .bind(tenantId)
    .first<TenantRow>();
}

export async function setTenantPlan(
  tenantId: TenantId,
  env: StorageEnv,
  plan: Plan,
): Promise<void> {
  await env.DB.prepare("UPDATE tenants SET plan = ?2 WHERE id = ?1").bind(tenantId, plan).run();
}
