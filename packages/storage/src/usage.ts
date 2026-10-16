import type { TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

/** The billing period a timestamp falls in: `YYYY-MM` in UTC. */
export function usagePeriod(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** Records the Tenant's stored bytes on this period's Usage row; run in the same batch as the write. */
export function usageSnapshot(
  env: StorageEnv,
  tenantId: TenantId,
  at: number,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO usage (tenant_id, period, storage_bytes)
     VALUES (?1, ?2, (SELECT COALESCE(SUM(bytes), 0) FROM document_versions WHERE tenant_id = ?1))
     ON CONFLICT (tenant_id, period) DO UPDATE SET storage_bytes = excluded.storage_bytes`,
  ).bind(tenantId, usagePeriod(at));
}

export interface UsageRow {
  period: string;
  ops: number;
  storageBytes: number;
}

/** The Tenant's Usage this period; storage is always the live total of its Version bytes. */
export async function getUsage(tenantId: TenantId, env: StorageEnv): Promise<UsageRow> {
  const period = usagePeriod(Date.now());
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(bytes), 0) FROM document_versions WHERE tenant_id = ?1) AS storageBytes,
       COALESCE((SELECT ops FROM usage WHERE tenant_id = ?1 AND period = ?2), 0) AS ops`,
  )
    .bind(tenantId, period)
    .first<{ storageBytes: number; ops: number }>();
  return { period, ops: row?.ops ?? 0, storageBytes: row?.storageBytes ?? 0 };
}

/**
 * Counts one page op against this period's Usage if fewer than `max` are used; atomic, so
 * concurrent ops cannot overshoot. False means the Limit is reached and nothing was counted.
 */
export async function claimPageOp(
  tenantId: TenantId,
  env: StorageEnv,
  max: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO usage (tenant_id, period, ops) VALUES (?1, ?2, 1)
     ON CONFLICT (tenant_id, period) DO UPDATE SET ops = ops + 1 WHERE usage.ops < ?3
     RETURNING ops`,
  )
    .bind(tenantId, usagePeriod(Date.now()), max)
    .first<{ ops: number }>();
  return row !== null;
}

/** Gives back a page op claimed this period whose result was not stored. */
export async function releasePageOp(tenantId: TenantId, env: StorageEnv): Promise<void> {
  await env.DB.prepare(
    "UPDATE usage SET ops = MAX(ops - 1, 0) WHERE tenant_id = ?1 AND period = ?2",
  )
    .bind(tenantId, usagePeriod(Date.now()))
    .run();
}
