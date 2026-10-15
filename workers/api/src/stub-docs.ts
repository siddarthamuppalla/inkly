import { authenticate, mintDocumentId, resolveTenant, type Session } from "@inkly/auth";
import type { DocumentId, TenantId } from "@inkly/domain";
import { isWellFormedId } from "@inkly/domain";
import { accessDenied, logEvent, type AccessAction } from "@inkly/domain/log";
import {
  appendAccessLog,
  createStubDoc,
  getStubDoc,
  getStubDocContent,
  listStubDocs,
  updateStubDoc,
} from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";

// T0.9 stub endpoints: tenant-scoped docs that exist only for verify-tenancy to attack.

type Vars = { session: Session; tenantId: TenantId };

export const stubDocs = new Hono<{ Bindings: Env; Variables: Vars }>();

async function deny(
  c: { env: Env; get: (key: "session") => Session },
  action: AccessAction,
  resource: string,
  status: 403 | 404,
): Promise<Response> {
  const session = c.get("session");
  const entry = accessDenied({
    actorTenantId: session.tenantId,
    actorUserId: session.userId,
    action,
    resource,
    status,
  });
  logEvent(entry);
  await appendAccessLog(session.tenantId, c.env, entry);
  return Response.json({ error: status === 403 ? "forbidden" : "not found" }, { status });
}

stubDocs.use("*", async (c, next) => {
  const session = await authenticate(c.req.header("authorization"), c.env);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("session", session);
  const requested = c.req.header("x-inkly-tenant") ?? c.req.query("tenant");
  const resolved = resolveTenant(session, requested, c.env);
  if (!resolved.ok) {
    const action: AccessAction =
      c.req.method !== "GET"
        ? "write"
        : c.req.path.endsWith("/content")
          ? "read-content"
          : /\/stub-docs\/?$/.test(c.req.path)
            ? "list"
            : "read";
    return deny(c, action, `${c.req.method} ${c.req.path}`, 403);
  }
  c.set("tenantId", resolved.tenantId);
  await next();
});

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
