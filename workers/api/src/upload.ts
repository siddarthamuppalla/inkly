import {
  AppError,
  assertFileSizeAllowed,
  assertUploadAllowed,
  type Plan,
  type TenantId,
} from "@inkly/domain";
import { inspect } from "@inkly/pdf";
import { getTenant, getUsage } from "@inkly/storage";

import type { Env } from "./env.ts";

/** Reads the request body, refusing it as soon as it passes the Plan's per-file limit. */
async function readBody(req: Request, plan: Plan): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared)) assertFileSizeAllowed(plan, declared);
  if (!req.body) throw new AppError("invalid_input", "The upload is empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (req.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    assertFileSizeAllowed(plan, total);
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function tenantPlan(tenantId: TenantId, env: Env): Promise<Plan> {
  return (await getTenant(tenantId, env))?.plan ?? "free";
}

/** Throws `limit_exceeded` when `bytes` more would not fit the Tenant's storage Limit. */
export async function assertStorageFor(tenantId: TenantId, env: Env, bytes: number): Promise<void> {
  const [plan, usage] = await Promise.all([tenantPlan(tenantId, env), getUsage(tenantId, env)]);
  assertUploadAllowed(plan, { fileBytes: bytes, storageBytes: usage.storageBytes });
}

/**
 * Receives an uploaded PDF: within Limits, a real unencrypted PDF, hashed and page-counted.
 * The whole file is checked before anything is written, so a refused upload stores nothing.
 */
export async function receivePdf(
  req: Request,
  tenantId: TenantId,
  env: Env,
): Promise<{ body: Uint8Array; sha256: string; pages: number }> {
  const body = await readBody(req, await tenantPlan(tenantId, env));
  await assertStorageFor(tenantId, env, body.byteLength);
  if (!String.fromCharCode(...body.subarray(0, 1024)).includes("%PDF-")) {
    throw new AppError("invalid_input", "The file is not a PDF");
  }
  const { pages, encrypted } = await inspect(body);
  if (encrypted) throw new AppError("pdf_encrypted", "The PDF is password-protected or encrypted");
  return { body, sha256: await sha256Hex(body), pages };
}
