import type { DocumentInfo, UserId } from "@inkly/domain";
import { getUsage } from "@inkly/storage";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { onAppError } from "../src/errors.ts";
import type { Env } from "../src/index.ts";
import { countedOp, pageOpRoutes } from "../src/page-ops.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { accessLog, as, folder, hooks, json, seed, upload, uploaded } from "./helpers.ts";

type Who = { token: string };

function op(who: Who, path: string, body: unknown) {
  return as(who, `/api/documents${path}`, json("POST", body));
}

async function content(who: Who, id: string): Promise<PDFDocument> {
  const res = await as(who, `/api/documents/${id}/content`);
  return PDFDocument.load(await res.arrayBuffer());
}

function rotations(doc: PDFDocument): number[] {
  return doc.getPages().map((p) => p.getRotation().angle);
}

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return doc.save();
}

describe("editing one Document", () => {
  it("rotates pages into a new Version that the content route serves", async () => {
    const a = await seed();
    const doc = await uploaded(a, "rotated.pdf");
    const res = await op(a, `/${doc.id}/rotate`, { pages: [1, 3], degrees: 90 });
    expect(res.status).toBe(201);
    expect((await res.json<{ document: DocumentInfo }>()).document).toMatchObject({
      id: doc.id,
      currentVersion: 2,
      pages: 3,
    });
    expect(rotations(await content(a, doc.id))).toEqual([90, 90, 0]);
    const v1 = await as(a, `/api/documents/${doc.id}/versions/1/content`);
    expect(rotations(await PDFDocument.load(await v1.arrayBuffer()))).toEqual([0, 90, 270]);
  });

  it("reorders pages", async () => {
    const a = await seed();
    const doc = await uploaded(a, "rotated.pdf");
    const res = await op(a, `/${doc.id}/reorder`, { order: [3, 1, 2] });
    expect(res.status).toBe(201);
    expect(rotations(await content(a, doc.id))).toEqual([270, 0, 90]);
  });

  it("deletes pages, and refuses to delete every page", async () => {
    const a = await seed();
    const doc = await uploaded(a, "10p.pdf");
    const res = await op(a, `/${doc.id}/delete-pages`, { pages: [2, 4, 4] });
    expect(res.status).toBe(201);
    expect((await res.json<{ document: DocumentInfo }>()).document).toMatchObject({
      currentVersion: 2,
      pages: 8,
    });
    const all = Array.from({ length: 8 }, (_, i) => i + 1);
    const refused = await op(a, `/${doc.id}/delete-pages`, { pages: all });
    expect(refused.status).toBe(422);
    expect((await as(a, `/api/documents/${doc.id}`)).status).toBe(200);
    expect((await getUsage(a.tenantId, env)).ops).toBe(1);
  });

  it("refuses a page past the end and a bad body with 422", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    expect((await op(a, `/${doc.id}/rotate`, { pages: [2], degrees: 90 })).status).toBe(422);
    expect((await op(a, `/${doc.id}/rotate`, { pages: [1], degrees: 45 })).status).toBe(422);
    expect((await op(a, `/${doc.id}/reorder`, { order: [1, 1] })).status).toBe(422);
  });
});

describe("merge and split", () => {
  it("merges two Documents into a new Document with the summed page count", async () => {
    const a = await seed();
    const box = await folder(a, "Box");
    const first = await uploaded(a, "10p.pdf", { folderId: box.id });
    const second = await uploaded(a, "rotated.pdf");
    const res = await op(a, "/merge", { documentIds: [first.id, second.id] });
    expect(res.status).toBe(201);
    const { document } = await res.json<{ document: DocumentInfo }>();
    expect(document).toMatchObject({
      title: "10p + rotated",
      folderId: box.id,
      pages: 13,
      currentVersion: 1,
    });
    expect(document.id).not.toBe(first.id);
    const merged = await content(a, document.id);
    expect(merged.getPageCount()).toBe(13);
    expect(rotations(merged).slice(10)).toEqual([0, 90, 270]);
  });

  it("splits by ranges into one new Document per range", async () => {
    const a = await seed();
    const doc = await uploaded(a, "10p.pdf");
    const res = await op(a, `/${doc.id}/split`, {
      ranges: [
        { from: 1, to: 3 },
        { from: 4, to: 4 },
        { from: 5, to: 10 },
      ],
    });
    expect(res.status).toBe(201);
    const { documents } = await res.json<{ documents: DocumentInfo[] }>();
    expect(documents.map((d) => [d.title, d.pages])).toEqual([
      ["10p (pp. 1-3)", 3],
      ["10p (p. 4)", 1],
      ["10p (pp. 5-10)", 6],
    ]);
    expect(
      await Promise.all(documents.map(async (d) => (await content(a, d.id)).getPageCount())),
    ).toEqual([3, 1, 6]);
    expect((await as(a, `/api/documents/${doc.id}`)).status).toBe(200);
  });

  it("refuses a merge with another Tenant's Document as 404, logged", async () => {
    const a = await seed();
    const b = await seed();
    const mine = await uploaded(a, "tiny.pdf");
    const theirs = await uploaded(b, "tiny.pdf");
    const res = await op(a, "/merge", { documentIds: [mine.id, theirs.id] });
    expect(res.status).toBe(404);
    const attempts = [
      [`/${theirs.id}/rotate`, { pages: [1], degrees: 90 }],
      [`/${theirs.id}/reorder`, { order: [1] }],
      [`/${theirs.id}/delete-pages`, { pages: [1] }],
      [`/${theirs.id}/split`, { ranges: [{ from: 1, to: 1 }] }],
    ] as const;
    for (const [path, req] of attempts) expect((await op(a, path, req)).status).toBe(404);
    expect((await accessLog(a.tenantId)).filter((e) => e.status === 404)).toHaveLength(5);
    const after = await as(b, `/api/documents/${theirs.id}`);
    expect((await after.json<{ document: DocumentInfo }>()).document).toEqual(theirs);
    const listed = await as(a, "/api/documents");
    expect((await listed.json<{ documents: DocumentInfo[] }>()).documents).toHaveLength(1);
    expect((await getUsage(a.tenantId, env)).ops).toBe(0);
  });
});

describe("limits", () => {
  it("counts page ops against the Free Limit: the 51st returns 402 limit_exceeded", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    for (let i = 0; i < 50; i++) {
      const res = await op(a, `/${doc.id}/rotate`, { pages: [1], degrees: 90 });
      expect(res.status).toBe(201);
    }
    expect((await getUsage(a.tenantId, env)).ops).toBe(50);
    const res = await op(a, `/${doc.id}/rotate`, { pages: [1], degrees: 90 });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "limit_exceeded" });
    const after = await as(a, `/api/documents/${doc.id}`);
    expect((await after.json<{ document: DocumentInfo }>()).document.currentVersion).toBe(51);
    expect((await getUsage(a.tenantId, env)).ops).toBe(50);
  }, 60_000);

  it("refuses a 201-page Document with 413 pointing at the Container path", async () => {
    const a = await seed();
    const res = await upload(a, await pdfWithPages(201), { filename: "long.pdf" });
    expect(res.status).toBe(201);
    const { document } = await res.json<{ document: DocumentInfo }>();
    const refused = await op(a, `/${document.id}/rotate`, { pages: [1], degrees: 90 });
    expect(refused.status).toBe(413);
    const body = await refused.json<{ error: string; message: string }>();
    expect(body.error).toBe("too_large_for_worker");
    expect(body.message).toContain("pdf-engine Container");
    expect((await getUsage(a.tenantId, env)).ops).toBe(0);
  });

  it("refuses a merge whose pages sum past 200", async () => {
    const a = await seed();
    const big = await upload(a, await pdfWithPages(150), { filename: "a.pdf" });
    const other = await upload(a, await pdfWithPages(60), { filename: "b.pdf" });
    const ids = [big, other].map(
      async (r) => (await r.json<{ document: DocumentInfo }>()).document.id,
    );
    const res = await op(a, "/merge", { documentIds: await Promise.all(ids) });
    expect(res.status).toBe(413);
  });
});

describe("counting", () => {
  it("gives the op back when nothing was stored, and keeps it once something was", async () => {
    const a = await seed();
    const fail = () => Promise.reject(new Error("write failed"));
    await expect(countedOp(a.tenantId, env, fail)).rejects.toThrow("write failed");
    expect((await getUsage(a.tenantId, env)).ops).toBe(0);
    const partial = (stored: () => void) => {
      stored();
      return fail();
    };
    await expect(countedOp(a.tenantId, env, partial)).rejects.toThrow("write failed");
    expect((await getUsage(a.tenantId, env)).ops).toBe(1);
  });
});

describe("a viewer Member", () => {
  it("gets 403 for every page op", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const session = {
      tenantId: owner.tenantId,
      userId: owner.userId as UserId,
      role: "viewer" as const,
      sessionId: "fixture-session",
    };
    const app = new Hono<{ Bindings: Env; Variables: TenantVars }>();
    app.onError(onAppError);
    app.use("*", async (c, next) => {
      c.set("session", session);
      c.set("tenantId", owner.tenantId);
      await next();
    });
    app.route("/api/documents", pageOpRoutes);
    const statuses = await Promise.all(
      (
        [
          [`/${doc.id}/rotate`, { pages: [1], degrees: 90 }],
          [`/${doc.id}/reorder`, { order: [1] }],
          [`/${doc.id}/delete-pages`, { pages: [1] }],
          [`/${doc.id}/split`, { ranges: [{ from: 1, to: 1 }] }],
          ["/merge", { documentIds: [doc.id, doc.id] }],
        ] as const
      ).map(async ([path, body]) => {
        const res = await app.request(`/api/documents${path}`, json("POST", body), hooks);
        return res.status;
      }),
    );
    expect(statuses).toEqual([403, 403, 403, 403, 403]);
  });
});
