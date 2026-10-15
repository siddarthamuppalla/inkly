import type { DocumentId, TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";
import { versionKey } from "./keys.ts";

export async function putVersionBytes(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  version: number,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  await env.FILES.put(versionKey(tenantId, documentId, version), bytes);
}

export async function getVersionBytes(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  version: number,
): Promise<ArrayBuffer | null> {
  const object = await env.FILES.get(versionKey(tenantId, documentId, version));
  return object ? object.arrayBuffer() : null;
}
