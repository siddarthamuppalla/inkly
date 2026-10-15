import { mintDocumentId } from "@inkly/auth";
import {
  DocumentPatch,
  isWellFormedId,
  titleFromFilename,
  type DocumentId,
  type FolderId,
} from "@inkly/domain";
import type { AccessAction } from "@inkly/domain/log";
import {
  addVersion,
  createDocument,
  getDocument,
  getFolder,
  listDocuments,
  listVersions,
  openVersion,
  restoreVersion,
  setTrashed,
  updateDocument,
  type DocumentRow,
} from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, grantAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";
import { assertStorageFor, receivePdf } from "./upload.ts";

// Mounted at /api/documents behind requireTenant.
export const documentRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

documentRoutes.use("*", viewersReadOnly);

function missing(c: TenantContext, action: AccessAction): Promise<Response> {
  return denyAccess(c, action, `${c.req.method} ${c.req.path}`, 404);
}

async function findDocument(c: TenantContext): Promise<DocumentRow | null> {
  const id = c.req.param("id") ?? "";
  return isWellFormedId(id) ? getDocument(c.get("tenantId"), c.env, id as DocumentId) : null;
}

/** The Tenant's folder named by `raw`; null = top level; undefined = no such folder. */
async function findFolder(
  c: TenantContext,
  raw: string | null,
): Promise<FolderId | null | undefined> {
  if (raw === null) return null;
  if (!isWellFormedId(raw)) return undefined;
  return (await getFolder(c.get("tenantId"), c.env, raw as FolderId))?.id;
}

function versionNumber(raw: string | undefined): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function contentDisposition(title: string): string {
  const filename = `${title}.pdf`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

documentRoutes.get("/", async (c) => {
  const tenantId = c.get("tenantId");
  if (c.req.query("trash") !== undefined) {
    return c.json({ documents: await listDocuments(tenantId, c.env, "trash") });
  }
  const folderId = await findFolder(c, c.req.query("folderId") ?? null);
  if (folderId === undefined) return missing(c, "list");
  return c.json({ documents: await listDocuments(tenantId, c.env, { folderId }) });
});

documentRoutes.post("/", async (c) => {
  const tenantId = c.get("tenantId");
  const folderId = await findFolder(c, c.req.query("folderId") ?? null);
  if (folderId === undefined) return missing(c, "write");
  const pdf = await receivePdf(c.req.raw, tenantId, c.env);
  const document = await createDocument(
    tenantId,
    c.env,
    { id: mintDocumentId(), title: titleFromFilename(c.req.query("filename")), folderId },
    { ...pdf, createdBy: c.get("session").userId },
  );
  return c.json({ document }, 201);
});

documentRoutes.get("/:id", async (c) => {
  const document = await findDocument(c);
  return document ? c.json({ document }) : missing(c, "read");
});

documentRoutes.patch("/:id", async (c) => {
  const patch = await parseJson(c.req.raw, DocumentPatch);
  const doc = await findDocument(c);
  if (!doc) return missing(c, "write");
  const folderId = patch.folderId === undefined ? undefined : await findFolder(c, patch.folderId);
  if (patch.folderId !== undefined && folderId === undefined) return missing(c, "write");
  const document = await updateDocument(c.get("tenantId"), c.env, doc.id, {
    title: patch.title,
    folderId,
  });
  return document ? c.json({ document }) : missing(c, "write");
});

async function trash(c: TenantContext, trashed: boolean): Promise<Response> {
  const doc = await findDocument(c);
  if (!doc || !(await setTrashed(c.get("tenantId"), c.env, doc.id, trashed))) {
    return missing(c, "write");
  }
  return c.json({ document: await getDocument(c.get("tenantId"), c.env, doc.id) });
}

documentRoutes.delete("/:id", (c) => trash(c, true));
documentRoutes.post("/:id/restore", (c) => trash(c, false));

async function serveContent(c: TenantContext, n: number | undefined): Promise<Response> {
  const doc = await findDocument(c);
  const opened =
    doc && (await openVersion(c.get("tenantId"), c.env, doc.id, n ?? doc.currentVersion));
  if (!doc || !opened) return missing(c, "read-content");
  await grantAccess(c, "read-content", `document ${doc.id} v${String(opened.version.n)}`);
  return new Response(opened.object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(opened.object.size),
      "content-disposition": contentDisposition(doc.title),
      etag: opened.object.etag,
      "cache-control": "private, no-store",
    },
  });
}

documentRoutes.get("/:id/content", (c) => serveContent(c, undefined));

documentRoutes.get("/:id/versions/:n/content", (c) => {
  const n = versionNumber(c.req.param("n"));
  return n === null ? missing(c, "read-content") : serveContent(c, n);
});

documentRoutes.get("/:id/versions", async (c) => {
  const doc = await findDocument(c);
  if (!doc) return missing(c, "list");
  const versions = await listVersions(c.get("tenantId"), c.env, doc.id);
  return c.json({
    versions: versions.map(({ n, sha256, bytes, pages, createdAt }) => ({
      n,
      sha256,
      bytes,
      pages,
      createdAt,
    })),
  });
});

documentRoutes.post("/:id/versions", async (c) => {
  const doc = await findDocument(c);
  if (!doc) return missing(c, "write");
  const pdf = await receivePdf(c.req.raw, c.get("tenantId"), c.env);
  const document = await addVersion(c.get("tenantId"), c.env, doc.id, {
    ...pdf,
    createdBy: c.get("session").userId,
  });
  return document ? c.json({ document }, 201) : missing(c, "write");
});

documentRoutes.post("/:id/versions/:n/restore", async (c) => {
  const tenantId = c.get("tenantId");
  const doc = await findDocument(c);
  const n = versionNumber(c.req.param("n"));
  const source =
    doc && n !== null
      ? (await listVersions(tenantId, c.env, doc.id)).find((v) => v.n === n)
      : undefined;
  if (!doc || !source) return missing(c, "write");
  await assertStorageFor(tenantId, c.env, source.bytes);
  const document = await restoreVersion(tenantId, c.env, doc.id, source.n, c.get("session").userId);
  return document ? c.json({ document }, 201) : missing(c, "write");
});
