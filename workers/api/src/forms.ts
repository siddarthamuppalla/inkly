import { FormFill } from "@inkly/domain";
import { fillForm, readFormFields } from "@inkly/pdf";
import { addVersion, openVersion } from "@inkly/storage";
import { Hono } from "hono";

import { findDocument, missing } from "./documents.ts";
import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { grantAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";
import { assertStorageFor, sha256Hex } from "./upload.ts";

// Mounted at /api/documents behind requireTenant. Filling a form saves a new Version.
export const formRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

formRoutes.use("*", viewersReadOnly);

/** The current Version's bytes, or null when the Document is not the caller's Tenant's. */
async function current(c: TenantContext) {
  const doc = await findDocument(c);
  const opened = doc && (await openVersion(c.get("tenantId"), c.env, doc.id, doc.currentVersion));
  if (!doc || !opened) return null;
  const bytes = new Uint8Array(await new Response(opened.object.body).arrayBuffer());
  return { doc, version: opened.version, bytes };
}

formRoutes.get("/:id/form", async (c) => {
  const found = await current(c);
  if (!found) return missing(c, "read-content");
  await grantAccess(c, "read-content", `document ${found.doc.id} v${String(found.version.n)} form`);
  return c.json({ fields: await readFormFields(found.bytes) });
});

formRoutes.post("/:id/form", async (c) => {
  const found = await current(c);
  if (!found) return missing(c, "write");
  const fill = await parseJson(c.req.raw, FormFill);
  const body = await fillForm(found.bytes, fill.values, { flatten: fill.flatten });
  const tenantId = c.get("tenantId");
  await assertStorageFor(tenantId, c.env, body.byteLength);
  const document = await addVersion(tenantId, c.env, found.doc.id, {
    body,
    sha256: await sha256Hex(body),
    pages: found.version.pages,
    createdBy: c.get("session").userId,
  });
  return document ? c.json({ document }, 201) : missing(c, "write");
});
