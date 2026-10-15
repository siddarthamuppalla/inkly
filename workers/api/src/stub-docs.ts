import { mintDocumentId } from "@inkly/auth";
import type { DocumentId } from "@inkly/domain";
import { isWellFormedId } from "@inkly/domain";
import {
  createStubDoc,
  getStubDoc,
  getStubDocContent,
  listStubDocs,
  updateStubDoc,
} from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import { denyAccess as deny, requireTenant, type TenantVars } from "./tenant-context.ts";

// T0.9 stub endpoints: tenant-scoped docs that exist only for verify-tenancy to attack.

export const stubDocs = new Hono<{ Bindings: Env; Variables: TenantVars }>();

stubDocs.use("*", requireTenant);

function docId(raw: string): DocumentId | null {
  return isWellFormedId(raw) ? (raw as DocumentId) : null;
}

stubDocs.get("/", async (c) => {
  return c.json({ docs: await listStubDocs(c.get("tenantId"), c.env) });
});

stubDocs.post("/", async (c) => {
  const body = await c.req
    .json<{ title?: unknown; content?: unknown }>()
    .catch((): { title?: unknown; content?: unknown } => ({}));
  const title = typeof body.title === "string" ? body.title : "untitled";
  const content = new TextEncoder().encode(typeof body.content === "string" ? body.content : "");
  const id = mintDocumentId();
  await createStubDoc(c.get("tenantId"), c.env, { id, title, content });
  return c.json({ id, title }, 201);
});

stubDocs.get("/:id", async (c) => {
  const id = docId(c.req.param("id"));
  const doc = id ? await getStubDoc(c.get("tenantId"), c.env, id) : null;
  return doc ? c.json(doc) : deny(c, "read", `stub-doc ${c.req.param("id")}`, 404);
});

stubDocs.put("/:id", async (c) => {
  const id = docId(c.req.param("id"));
  const body = await c.req.json<{ title?: unknown }>().catch((): { title?: unknown } => ({}));
  const title = typeof body.title === "string" ? body.title : "";
  const updated = id && title ? await updateStubDoc(c.get("tenantId"), c.env, id, title) : false;
  return updated ? c.json({ id, title }) : deny(c, "write", `stub-doc ${c.req.param("id")}`, 404);
});

stubDocs.get("/:id/content", async (c) => {
  const id = docId(c.req.param("id"));
  const bytes = id ? await getStubDocContent(c.get("tenantId"), c.env, id) : null;
  return bytes
    ? c.body(bytes, 200, { "content-type": "application/octet-stream" })
    : deny(c, "read-content", `stub-doc ${c.req.param("id")}/content`, 404);
});
