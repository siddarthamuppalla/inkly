import type { DocumentInfo, FolderInfo, TenantId } from "@inkly/domain";
import { env } from "cloudflare:workers";

import app, { type Env } from "../src/index.ts";

// Random per run so no secret-shaped literal lives in the repo (gitleaks).
export const SECRET = crypto.randomUUID();
export const hooks: Env = { ...env, TEST_HOOKS: "enabled", TEST_HOOKS_SECRET: SECRET };

export interface Seeded {
  tenantId: TenantId;
  userId: string;
  token: string;
}

export async function seed(): Promise<Seeded> {
  const res = await app.request(
    "/__test/seed",
    { method: "POST", headers: { "x-test-hooks-secret": SECRET } },
    hooks,
  );
  return res.json<Seeded>();
}

export function fixture(name: string): Uint8Array {
  const b64 = env.TEST_FIXTURES[name];
  if (b64 === undefined) throw new Error(`fixture ${name} is not loaded in vitest.config.ts`);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function sha256(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function as(who: { token: string }, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${who.token}`);
  return app.request(path, { ...init, headers }, hooks);
}

export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function upload(
  who: { token: string },
  bytes: Uint8Array,
  query: Record<string, string> = { filename: "doc.pdf" },
) {
  return as(who, `/api/documents?${new URLSearchParams(query).toString()}`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: bytes,
  });
}

export async function uploaded(
  who: { token: string },
  name: string,
  query: Record<string, string> = {},
): Promise<DocumentInfo> {
  const res = await upload(who, fixture(name), { filename: name, ...query });
  if (res.status !== 201)
    throw new Error(`upload ${name}: ${String(res.status)} ${await res.text()}`);
  return (await res.json<{ document: DocumentInfo }>()).document;
}

export async function folder(
  who: { token: string },
  name: string,
  parentId: string | null = null,
): Promise<FolderInfo> {
  const res = await as(who, "/api/folders", json("POST", { name, parentId }));
  if (res.status !== 201) throw new Error(`folder ${name}: ${String(res.status)}`);
  return (await res.json<{ folder: FolderInfo }>()).folder;
}

export async function accessLog(tenantId: string) {
  const res = await app.request(
    `/__test/access-log?tenant=${tenantId}`,
    { headers: { "x-test-hooks-secret": SECRET } },
    hooks,
  );
  return (await res.json<{ entries: { action: string; resource: string; status: number }[] }>())
    .entries;
}
