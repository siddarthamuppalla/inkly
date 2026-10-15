import type { DocumentId, TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";
import { tenantPrefix, versionKey } from "./keys.ts";

/** Uploads above this size go to R2 as a multipart upload, in parts of this size. */
export const MULTIPART_PART_BYTES = 10 * 1024 * 1024;

export async function putVersionObject(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  n: number,
  body: Uint8Array,
  sha256: string,
): Promise<void> {
  const key = versionKey(tenantId, documentId, n);
  if (body.byteLength <= MULTIPART_PART_BYTES) {
    await env.FILES.put(key, body, { sha256 });
    return;
  }
  const upload = await env.FILES.createMultipartUpload(key);
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0; offset < body.byteLength; offset += MULTIPART_PART_BYTES) {
      const part = body.subarray(offset, offset + MULTIPART_PART_BYTES);
      parts.push(await upload.uploadPart(parts.length + 1, part));
    }
    await upload.complete(parts);
  } catch (err) {
    await upload.abort();
    throw err;
  }
}

export async function copyVersionObject(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  from: number,
  to: number,
): Promise<boolean> {
  const source = await env.FILES.get(versionKey(tenantId, documentId, from));
  if (!source) return false;
  await env.FILES.put(versionKey(tenantId, documentId, to), source.body);
  return true;
}

export interface VersionObject {
  readonly body: ReadableStream;
  readonly size: number;
  readonly etag: string;
}

export async function getVersionObject(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  n: number,
): Promise<VersionObject | null> {
  const object = await env.FILES.get(versionKey(tenantId, documentId, n));
  return object ? { body: object.body, size: object.size, etag: object.httpEtag } : null;
}

export async function deleteVersionObject(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  n: number,
): Promise<void> {
  await env.FILES.delete(versionKey(tenantId, documentId, n));
}

/** Every R2 key stored under the Tenant's prefix. */
export async function listTenantObjectKeys(tenantId: TenantId, env: StorageEnv): Promise<string[]> {
  const prefix = tenantPrefix(tenantId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list(cursor === undefined ? { prefix } : { prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}
