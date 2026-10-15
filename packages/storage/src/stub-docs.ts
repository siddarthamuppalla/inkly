import type { DocumentId, TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";
import { getVersionBytes, putVersionBytes } from "./versions.ts";

// T0.9 stub resource: exists only so verify-tenancy has something real to attack.
// Real documents (ADR-0008) replace it.

export interface StubDocRow {
  id: DocumentId;
  title: string;
  createdAt: number;
}

export async function createStubDoc(
  tenantId: TenantId,
  env: StorageEnv,
  doc: { id: DocumentId; title: string; content: Uint8Array },
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO stub_docs (tenant_id, id, title, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(tenantId, doc.id, doc.title, Date.now())
    .run();
  await putVersionBytes(tenantId, env, doc.id, 1, doc.content);
}

export async function getStubDoc(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
): Promise<StubDocRow | null> {
  return env.DB.prepare(
    "SELECT id, title, created_at AS createdAt FROM stub_docs WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, id)
    .first<StubDocRow>();
}

export async function listStubDocs(tenantId: TenantId, env: StorageEnv): Promise<StubDocRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, created_at AS createdAt FROM stub_docs WHERE tenant_id = ?1 ORDER BY created_at",
  )
    .bind(tenantId)
    .all<StubDocRow>();
  return results;
}

/** Updates the title of an existing doc. Returns false when the tenant has no such doc. */
export async function updateStubDoc(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  title: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE stub_docs SET title = ?3 WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, id, title)
    .run();
  return res.meta.changes > 0;
}

export async function getStubDocContent(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
): Promise<ArrayBuffer | null> {
  return getVersionBytes(tenantId, env, id, 1);
}
