import { mintDocumentId } from "@inkly/auth";
import {
  AppError,
  DeletePagesRequest,
  isWellFormedId,
  MergeRequest,
  PLAN_LIMITS,
  pageOpLimitError,
  ReorderRequest,
  RotateRequest,
  SplitRequest,
  type DocumentId,
  type TenantId,
} from "@inkly/domain";
import {
  deletePages,
  inspect,
  MAX_WORKER_BYTES,
  MAX_WORKER_PAGES,
  merge,
  pageNumber,
  reorder,
  rotate,
  split,
} from "@inkly/pdf";
import {
  addVersion,
  claimPageOp,
  createDocument,
  getDocument,
  openVersion,
  releasePageOp,
  type DocumentRow,
} from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";
import { assertStorageFor, sha256Hex, tenantPlan } from "./upload.ts";

// Page ops (T1.3b), mounted at /api/documents behind requireTenant. Each edit of one
// Document stores a new Version; merge and split store new Documents. Every op counts
// once against the Plan's monthly page-op Limit, and is given back if nothing is stored.

export const pageOpRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

pageOpRoutes.use("*", viewersReadOnly);

const MiB = 1024 * 1024;

/** Refuses work too big for a Worker before loading any bytes; it belongs on pdf-engine. */
function assertWorkerSized(bytes: number, pages: number): void {
  if (bytes > MAX_WORKER_BYTES || pages > MAX_WORKER_PAGES) {
    throw new AppError(
      "too_large_for_worker",
      `Page edits here handle up to ${String(MAX_WORKER_BYTES / MiB)} MB and ${String(MAX_WORKER_PAGES)} pages; ` +
        `this is ${(bytes / MiB).toFixed(1)} MB and ${String(pages)} pages. Larger files go through the pdf-engine Container path.`,
    );
  }
}

async function findDocuments(
  c: TenantContext,
  ids: readonly string[],
): Promise<DocumentRow[] | null> {
  const docs: DocumentRow[] = [];
  for (const id of ids) {
    const doc = isWellFormedId(id)
      ? await getDocument(c.get("tenantId"), c.env, id as DocumentId)
      : null;
    if (!doc) return null;
    docs.push(doc);
  }
  return docs;
}

async function currentBytes(c: TenantContext, doc: DocumentRow): Promise<Uint8Array> {
  const opened = await openVersion(c.get("tenantId"), c.env, doc.id, doc.currentVersion);
  if (!opened) throw new Error(`current version of ${doc.id} is missing`);
  return new Uint8Array(await new Response(opened.object.body).arrayBuffer());
}

/**
 * Runs `op` as one counted page op: claimed first, given back when `op` throws before it
 * stored anything. Once `op` calls `stored`, the op stays counted even if a later write fails.
 */
export async function countedOp<T>(
  tenantId: TenantId,
  env: Env,
  op: (stored: () => void) => Promise<T>,
): Promise<T> {
  const plan = await tenantPlan(tenantId, env);
  if (!(await claimPageOp(tenantId, env, PLAN_LIMITS[plan].pageOps))) {
    throw pageOpLimitError(plan);
  }
  const progress = { stored: false };
  try {
    return await op(() => {
      progress.stored = true;
    });
  } catch (err) {
    if (!progress.stored) await releasePageOp(tenantId, env);
    throw err;
  }
}

async function newVersion(c: TenantContext, body: Uint8Array) {
  const { pages } = await inspect(body);
  return { body, sha256: await sha256Hex(body), pages, createdBy: c.get("session").userId };
}

/** Applies `edit` to a Document's current Version and stores the result as a new Version. */
async function editDocument(
  c: TenantContext,
  edit: (bytes: Uint8Array) => Promise<Uint8Array>,
): Promise<Response> {
  const tenantId = c.get("tenantId");
  const [doc] = (await findDocuments(c, [c.req.param("id") ?? ""])) ?? [];
  if (!doc) return denyAccess(c, "write", `${c.req.method} ${c.req.path}`, 404);
  assertWorkerSized(doc.bytes, doc.pages);
  const document = await countedOp(tenantId, c.env, async () => {
    const out = await edit(await currentBytes(c, doc));
    await assertStorageFor(tenantId, c.env, out.byteLength);
    const stored = await addVersion(tenantId, c.env, doc.id, await newVersion(c, out));
    if (!stored) throw new AppError("not_found", "The Document was deleted during the edit");
    return stored;
  });
  return c.json({ document }, 201);
}

/** Stores each output as a new Document in `like`'s folder, after one storage check for all. */
async function storeNewDocuments(
  c: TenantContext,
  like: DocumentRow,
  outputs: readonly { title: string; body: Uint8Array }[],
  stored: () => void,
): Promise<DocumentRow[]> {
  const tenantId = c.get("tenantId");
  await assertStorageFor(
    tenantId,
    c.env,
    outputs.reduce((sum, o) => sum + o.body.byteLength, 0),
  );
  const created: DocumentRow[] = [];
  for (const { title, body } of outputs) {
    created.push(
      await createDocument(
        tenantId,
        c.env,
        { id: mintDocumentId(), title, folderId: like.folderId },
        await newVersion(c, body),
      ),
    );
    stored();
  }
  return created;
}

pageOpRoutes.post("/:id/rotate", async (c) => {
  const req = await parseJson(c.req.raw, RotateRequest);
  return editDocument(c, (bytes) => rotate(bytes, req.pages.map(pageNumber), req.degrees));
});

pageOpRoutes.post("/:id/reorder", async (c) => {
  const req = await parseJson(c.req.raw, ReorderRequest);
  return editDocument(c, (bytes) => reorder(bytes, req.order.map(pageNumber)));
});

pageOpRoutes.post("/:id/delete-pages", async (c) => {
  const req = await parseJson(c.req.raw, DeletePagesRequest);
  return editDocument(c, (bytes) => deletePages(bytes, req.pages.map(pageNumber)));
});

pageOpRoutes.post("/merge", async (c) => {
  const req = await parseJson(c.req.raw, MergeRequest);
  const docs = await findDocuments(c, req.documentIds);
  const first = docs?.[0];
  if (!docs || !first) return denyAccess(c, "write", `${c.req.method} ${c.req.path}`, 404);
  assertWorkerSized(
    docs.reduce((sum, d) => sum + d.bytes, 0),
    docs.reduce((sum, d) => sum + d.pages, 0),
  );
  const tenantId = c.get("tenantId");
  const [document] = await countedOp(tenantId, c.env, async (stored) => {
    const inputs: Uint8Array[] = [];
    for (const doc of docs) inputs.push(await currentBytes(c, doc));
    const title =
      req.title ??
      docs
        .map((d) => d.title)
        .join(" + ")
        .slice(0, 200);
    return storeNewDocuments(c, first, [{ title, body: await merge(inputs) }], stored);
  });
  return c.json({ document }, 201);
});

pageOpRoutes.post("/:id/split", async (c) => {
  const req = await parseJson(c.req.raw, SplitRequest);
  const [doc] = (await findDocuments(c, [c.req.param("id")])) ?? [];
  if (!doc) return denyAccess(c, "write", `${c.req.method} ${c.req.path}`, 404);
  assertWorkerSized(doc.bytes, doc.pages);
  const ranges = req.ranges.map((r) => ({ from: pageNumber(r.from), to: pageNumber(r.to) }));
  const documents = await countedOp(c.get("tenantId"), c.env, async (stored) => {
    const parts = await split(await currentBytes(c, doc), ranges);
    return storeNewDocuments(
      c,
      doc,
      parts.map((body, i) => {
        const { from, to } = req.ranges[i] ?? { from: 0, to: 0 };
        const pages = from === to ? `p. ${String(from)}` : `pp. ${String(from)}-${String(to)}`;
        return { title: `${doc.title} (${pages})`.slice(0, 200), body };
      }),
      stored,
    );
  });
  return c.json({ documents }, 201);
});
