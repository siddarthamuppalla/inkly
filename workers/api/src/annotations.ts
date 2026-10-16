import { withAnnotations } from "@inkly/pdf";
import {
  AnnotationPatch,
  AnnotationShape,
  AppError,
  CommentCreate,
  isWellFormedId,
  type DocumentId,
} from "@inkly/domain";
import type { AccessAction } from "@inkly/domain/log";
import { getDocument, listMembers, openVersion, type DocumentRow } from "@inkly/storage";
import { Hono } from "hono";

import { ACTOR_HEADER, docSession, type Actor, type Outcome } from "./doc-session.ts";
import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, grantAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";

// Mounted at /api/documents behind requireTenant. Every route looks the Document up in the
// caller's Tenant before it reaches the Document's DocSession.
export const annotationRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

annotationRoutes.use("/:id/annotations/*", viewersReadOnly);
annotationRoutes.use("/:id/annotations", viewersReadOnly);

function missing(c: TenantContext, action: AccessAction): Promise<Response> {
  return denyAccess(c, action, `${c.req.method} ${c.req.path}`, 404);
}

async function findDocument(c: TenantContext): Promise<DocumentRow | null> {
  const id = c.req.param("id") ?? "";
  return isWellFormedId(id) ? getDocument(c.get("tenantId"), c.env, id as DocumentId) : null;
}

async function actorOf(c: TenantContext): Promise<Actor> {
  const { tenantId, userId, role } = c.get("session");
  const member = (await listMembers(tenantId, c.env)).find((m) => m.userId === userId);
  const name = member?.name.trim() || member?.email.split("@")[0] || "Member";
  return { userId, role, name };
}

/** The Document and its DocSession, plus the Annotation id when the route names one. */
async function target(c: TenantContext) {
  const doc = await findDocument(c);
  const aid = c.req.param("aid");
  if (!doc || (aid !== undefined && !isWellFormedId(aid))) return null;
  return { doc, session: docSession(c.env, c.get("tenantId"), doc), aid: aid ?? "" };
}

async function answer<T>(
  c: TenantContext,
  outcome: Outcome<T>,
  body: (value: T) => object,
  status: 200 | 201 = 200,
) {
  if (outcome.ok) return c.json(body(outcome.value), status);
  if (outcome.reason === "invalid_input") {
    throw new AppError("invalid_input", "Only a note's text can be edited");
  }
  const resource = `${c.req.method} ${c.req.path}`;
  return denyAccess(c, "write", resource, outcome.reason === "forbidden" ? 403 : 404);
}

annotationRoutes.get("/:id/annotations", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "list");
  return c.json({ annotations: await t.session.list() });
});

annotationRoutes.post("/:id/annotations", async (c) => {
  const shape = await parseJson(c.req.raw, AnnotationShape);
  const t = await target(c);
  if (!t) return missing(c, "write");
  if (shape.page > t.doc.pages) {
    throw new AppError(
      "invalid_input",
      `page ${String(shape.page)} does not exist; the Document has ${String(t.doc.pages)}`,
    );
  }
  const annotation = await t.session.create(await actorOf(c), t.doc.currentVersion, shape);
  return c.json({ annotation }, 201);
});

annotationRoutes.get("/:id/annotations/live", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "read");
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "upgrade_required", message: "Open this URL as a WebSocket" }, 426);
  }
  return t.session.fetch("https://doc-session/live", {
    headers: { upgrade: "websocket", [ACTOR_HEADER]: JSON.stringify(await actorOf(c)) },
  });
});

annotationRoutes.patch("/:id/annotations/:aid", async (c) => {
  const patch = await parseJson(c.req.raw, AnnotationPatch);
  const t = await target(c);
  if (!t) return missing(c, "write");
  return answer(c, await t.session.edit(await actorOf(c), t.aid, patch), (annotation) => ({
    annotation,
  }));
});

annotationRoutes.delete("/:id/annotations/:aid", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "write");
  return answer(c, await t.session.remove(await actorOf(c), t.aid), () => ({ deleted: t.aid }));
});

annotationRoutes.post("/:id/annotations/:aid/comments", async (c) => {
  const { text } = await parseJson(c.req.raw, CommentCreate);
  const t = await target(c);
  if (!t) return missing(c, "write");
  const outcome = await t.session.addComment(await actorOf(c), t.aid, text);
  return answer(c, outcome, (annotation) => ({ annotation }), 201);
});

for (const [path, resolved] of [
  ["resolve", true],
  ["reopen", false],
] as const) {
  annotationRoutes.post(`/:id/annotations/:aid/${path}`, async (c) => {
    const t = await target(c);
    if (!t) return missing(c, "write");
    return answer(c, await t.session.setResolved(t.aid, resolved), (annotation) => ({
      annotation,
    }));
  });
}

function attachment(title: string): string {
  const filename = `${title} (annotated).pdf`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** "Download with annotations": the current Version with its Annotations; stores nothing. */
annotationRoutes.get("/:id/annotated-content", async (c) => {
  const t = await target(c);
  const opened = t && (await openVersion(c.get("tenantId"), c.env, t.doc.id, t.doc.currentVersion));
  if (!t || !opened) return missing(c, "read-content");
  const [bytes, annotations] = await Promise.all([
    new Response(opened.object.body).arrayBuffer(),
    t.session.list(),
  ]);
  const onThisVersion = annotations.filter((a) => a.version === t.doc.currentVersion);
  const pdf = await withAnnotations(new Uint8Array(bytes), onThisVersion);
  await grantAccess(
    c,
    "read-content",
    `document ${t.doc.id} v${String(t.doc.currentVersion)} with annotations`,
  );
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.byteLength),
      "content-disposition": attachment(t.doc.title),
      "cache-control": "private, no-store",
    },
  });
});
