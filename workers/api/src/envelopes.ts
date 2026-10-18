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
  type EnvelopeRow,
} from "@inkly/storage";
import { Hono } from "hono";

import { envelopePdf, envelopeVersion } from "./envelope/content.ts";
import {
  envelopeObject,
  newEnvelopeObject,
  type EnvelopeOutcome,
  type Sender,
} from "./envelope/do.ts";
import { sealCertificatePem } from "./envelope/seal-key.ts";
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
  const n = envelope && envelopeVersion(envelope);
  const pdf = envelope && n !== null && (await envelopePdf(c.get("tenantId"), c.env, envelope, n));
  if (!envelope || !pdf) return missing(c, "read-content");
  await grantAccess(
    c,
    "read-content",
    `envelope ${envelope.id} document ${envelope.documentId} v${String(n)}`,
  );
  return pdf;
});

/** `GET /api/seal-certificate`: public, so anyone can check a sealed PDF (ADR-0006). */
export const sealCertificateRoutes = new Hono<{ Bindings: Env }>();

sealCertificateRoutes.get("/seal-certificate", async (c) => {
  const pem = await sealCertificatePem(c.env);
  if (pem === null) throw new AppError("not_found", "No seal certificate is configured");
  return c.body(`${pem}\n`, 200, {
    "content-type": "application/x-pem-file",
    "content-disposition": 'inline; filename="inkly-seal.pem"',
    "cache-control": "public, max-age=300",
  });
});
