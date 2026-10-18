import {
  AppError,
  EnvelopeCreate,
  EnvelopeDraft,
  EnvelopeListQuery,
  EnvelopeVoid,
  isWellFormedId,
  verifyChain,
  type DocumentId,
  type EnvelopeId,
} from "@inkly/domain";
import type { AccessAction } from "@inkly/domain/log";
import {
  getDocument,
  getEnvelope,
  listAuditEvents,
  listEnvelopes,
  listFields,
  listMembers,
  listRecipients,
  openVersion,
  type EnvelopeRow,
} from "@inkly/storage";
import { Hono } from "hono";

import {
  envelopeObject,
  newEnvelopeObject,
  type EnvelopeOutcome,
  type Sender,
} from "./envelope/do.ts";
import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, grantAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";

// T3.1 sender API, mounted at /api/envelopes behind requireTenant. Every route looks the
// Envelope (or Document) up in the caller's Tenant before anything else, and reaches the
// Envelope DO only with the looked-up row. Signer routes (/api/sign/:token) are T3.3.

export const envelopeRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

envelopeRoutes.use("*", viewersReadOnly);

function missing(c: TenantContext, action: AccessAction): Promise<Response> {
  return denyAccess(c, action, `${c.req.method} ${c.req.path}`, 404);
}

async function findEnvelope(c: TenantContext): Promise<EnvelopeRow | null> {
  const id = c.req.param("id") ?? "";
  return isWellFormedId(id) ? getEnvelope(c.get("tenantId"), c.env, id as EnvelopeId) : null;
}

async function senderOf(c: TenantContext): Promise<Sender> {
  const { tenantId, userId } = c.get("session");
  const member = (await listMembers(tenantId, c.env)).find((m) => m.userId === userId);
  const email = member?.email ?? "";
  return {
    userId,
    name: member?.name.trim() || email.split("@")[0] || "An Inkly user",
    email,
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

/** Where signer links point: the public app origin. */
function originOf(c: TenantContext): string {
  return c.env.BETTER_AUTH_URL ?? new URL(c.req.url).origin;
}

function unwrap<T>(outcome: EnvelopeOutcome<T>): T {
  if (!outcome.ok) throw new AppError(outcome.code, outcome.message);
  return outcome.value;
}

envelopeRoutes.post("/", async (c) => {
  const { documentId } = await parseJson(c.req.raw, EnvelopeCreate);
  const tenantId = c.get("tenantId");
  const doc = await getDocument(tenantId, c.env, documentId as DocumentId);
  if (!doc) return missing(c, "write");
  if (doc.deletedAt !== null) {
    throw new AppError("conflict", "Restore this document from Trash before sending it");
  }
  const created = newEnvelopeObject(c.env, tenantId, doc);
  const detail = unwrap(await created.stub.create(created.ref, created.doc, await senderOf(c)));
  return c.json(detail, 201);
});

envelopeRoutes.get("/", async (c) => {
  const query = EnvelopeListQuery.safeParse({ status: c.req.query("status") });
  if (!query.success) throw new AppError("invalid_input", "Unknown envelope status");
  const where = query.data.status === undefined ? {} : { status: query.data.status };
  return c.json({ envelopes: await listEnvelopes(c.get("tenantId"), c.env, where) });
});

envelopeRoutes.get("/:id", async (c) => {
  const envelope = await findEnvelope(c);
  if (!envelope) return missing(c, "read");
  const tenantId = c.get("tenantId");
  const [recipients, fields] = await Promise.all([
    listRecipients(tenantId, c.env, envelope.id),
    listFields(tenantId, c.env, envelope.id),
  ]);
  return c.json({ envelope, recipients, fields });
});

/** The Envelope the route names in the caller's Tenant, and its DO. */
async function target(c: TenantContext) {
  const envelope = await findEnvelope(c);
  if (!envelope) return null;
  const tenantId = c.get("tenantId");
  return {
    object: envelopeObject(c.env, tenantId, envelope),
    ref: { tenantId, envelopeId: envelope.id },
  };
}

envelopeRoutes.put("/:id", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "write");
  const draft = await parseJson(c.req.raw, EnvelopeDraft);
  return c.json(unwrap(await t.object.updateDraft(t.ref, draft)));
});

envelopeRoutes.delete("/:id", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "write");
  unwrap(await t.object.deleteDraft(t.ref));
  return c.body(null, 204);
});

envelopeRoutes.post("/:id/send", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "write");
  return c.json(unwrap(await t.object.send(t.ref, await senderOf(c), originOf(c))));
});

envelopeRoutes.post("/:id/void", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "write");
  const { reason } = await parseJson(c.req.raw, EnvelopeVoid);
  return c.json(unwrap(await t.object.voidEnvelope(t.ref, await senderOf(c), reason)));
});

envelopeRoutes.post("/:id/remind", async (c) => {
  const t = await target(c);
  if (!t) return missing(c, "write");
  return c.json(unwrap(await t.object.remind(t.ref, await senderOf(c), originOf(c))));
});

envelopeRoutes.get("/:id/audit", async (c) => {
  const envelope = await findEnvelope(c);
  if (!envelope) return missing(c, "read");
  const events = await listAuditEvents(c.get("tenantId"), c.env, "envelope", envelope.id);
  const { valid, head } = verifyChain(events);
  return c.json({ events, chain: { valid, head } });
});

envelopeRoutes.get("/:id/content", async (c) => {
  const envelope = await findEnvelope(c);
  const opened =
    envelope &&
    (await openVersion(c.get("tenantId"), c.env, envelope.documentId, envelope.version));
  if (!envelope || !opened) return missing(c, "read-content");
  await grantAccess(
    c,
    "read-content",
    `envelope ${envelope.id} document ${envelope.documentId} v${String(envelope.version)}`,
  );
  const filename = `${envelope.title}.pdf`.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(opened.object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(opened.object.size),
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "private, no-store",
    },
  });
});
