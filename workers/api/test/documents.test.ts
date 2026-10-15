import type { DocumentInfo, FolderInfo, VersionInfo } from "@inkly/domain";
import { listTenantObjectKeys, openVersion, versionKey } from "@inkly/storage";
import type { DocumentId } from "@inkly/domain";
import { env } from "cloudflare:workers";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { accessLog, as, fixture, folder, json, seed, sha256, upload, uploaded } from "./helpers.ts";

const MiB = 1024 * 1024;

/** A valid one-page PDF padded past `bytes` with an uncompressed random stream. */
async function bigPdf(bytes: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const pad = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 65536) crypto.getRandomValues(pad.subarray(i, i + 65536));
  doc.context.register(doc.context.stream(pad));
  return doc.save();
}

async function body<T>(res: Response): Promise<T> {
  return res.json<T>();
}

describe("upload", () => {
  it("stores 10p.pdf as Version 1 at t/{tid}/d/{did}/v1 with sha256, bytes and pages", async () => {
    const a = await seed();
    const bytes = fixture("10p.pdf");
    const res = await upload(a, bytes, { filename: "10p.pdf" });
    expect(res.status).toBe(201);
    const { document } = await body<{ document: DocumentInfo }>(res);
    expect(document).toMatchObject({
      title: "10p",
      folderId: null,
      currentVersion: 1,
      pages: 10,
      bytes: bytes.byteLength,
      sha256: await sha256(bytes),
      deletedAt: null,
    });

    const id = document.id as DocumentId;
    expect(versionKey(a.tenantId, id, 1)).toBe(`t/${a.tenantId}/d/${id}/v1`);
    expect(await listTenantObjectKeys(a.tenantId, env)).toEqual([`t/${a.tenantId}/d/${id}/v1`]);
    const stored = await openVersion(a.tenantId, env, id, 1);
    expect(stored && (await sha256(await new Response(stored.object.body).arrayBuffer()))).toBe(
      await sha256(bytes),
    );

    const versions = await body<{ versions: VersionInfo[] }>(
      await as(a, `/api/documents/${id}/versions`),
    );
    expect(versions.versions).toEqual([
      {
        n: 1,
        sha256: await sha256(bytes),
        bytes: bytes.byteLength,
        pages: 10,
        createdAt: expect.any(Number) as number,
      },
    ]);
  });

  it("uses R2 multipart above 10 MB and keeps the source sha256", async () => {
    const a = await seed();
    const bytes = await bigPdf(11 * MiB);
    const res = await upload(a, bytes, { filename: "big.pdf" });
    expect(res.status).toBe(201);
    const { document } = await body<{ document: DocumentInfo }>(res);
    expect(document.sha256).toBe(await sha256(bytes));

    const content = await as(a, `/api/documents/${document.id}/content`);
    expect(content.headers.get("etag")).toMatch(/-2"$/);
    expect(await sha256(await content.arrayBuffer())).toBe(await sha256(bytes));
  });

  it("refuses a 26 MB file on the Free plan with 413 limit_exceeded and stores nothing", async () => {
    const a = await seed();
    const big = new Uint8Array(26 * MiB);
    const sized = await upload(a, big);
    expect(sized.status).toBe(413);
    expect(await sized.json()).toMatchObject({ error: "limit_exceeded" });

    const streamed = await as(a, "/api/documents?filename=x.pdf", {
      method: "POST",
      body: new Blob([big]).stream(),
      // @ts-expect-error workerd needs duplex for a streamed request body
      duplex: "half",
    });
    expect(streamed.status).toBe(413);
    expect(await listTenantObjectKeys(a.tenantId, env)).toEqual([]);
  });

  it.each([
    ["a text file", new TextEncoder().encode("hello, not a pdf"), "invalid_input"],
    ["malformed.pdf", fixture("malformed.pdf"), "pdf_malformed"],
    ["encrypted.pdf", fixture("encrypted.pdf"), "pdf_encrypted"],
  ])("refuses %s with 422 and writes nothing", async (_, bytes, code) => {
    const a = await seed();
    const res = await upload(a, bytes);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: code });
    expect(await listTenantObjectKeys(a.tenantId, env)).toEqual([]);
    expect(await body<{ documents: unknown[] }>(await as(a, "/api/documents"))).toEqual({
      documents: [],
    });
  });

  it("refuses an upload into a folder the Tenant does not have", async () => {
    const a = await seed();
    const res = await upload(a, fixture("tiny.pdf"), { folderId: "fld_nope" });
    expect(res.status).toBe(404);
    expect(await listTenantObjectKeys(a.tenantId, env)).toEqual([]);
  });

  it("requires a session", async () => {
    expect((await upload({ token: "f".repeat(64) }, fixture("tiny.pdf"))).status).toBe(401);
  });
});

describe("GET /api/session", () => {
  it("answers 200 whether or not the caller is signed in", async () => {
    const a = await seed();
    const anon = await as({ token: "f".repeat(64) }, "/api/session");
    expect([anon.status, await anon.json()]).toEqual([200, { signedIn: false }]);
    const signed = await as(a, "/api/session");
    expect([signed.status, await signed.json()]).toEqual([200, { signedIn: true }]);
  });

  it("leaves the list routes behind requireTenant", async () => {
    expect((await as({ token: "f".repeat(64) }, "/api/documents")).status).toBe(401);
    expect((await as({ token: "f".repeat(64) }, "/api/folders")).status).toBe(401);
  });
});

describe("list, get and download", () => {
  it("lists Documents newest first with title, pages, size and updated time", async () => {
    const a = await seed();
    await uploaded(a, "tiny.pdf");
    await new Promise((r) => setTimeout(r, 5));
    await uploaded(a, "10p.pdf");
    const { documents } = await body<{ documents: DocumentInfo[] }>(await as(a, "/api/documents"));
    expect(documents.map((d) => [d.title, d.pages, d.bytes])).toEqual([
      ["10p", 10, fixture("10p.pdf").byteLength],
      ["tiny", 1, fixture("tiny.pdf").byteLength],
    ]);
    expect(documents[0]?.updatedAt).toBeGreaterThanOrEqual(documents[1]?.updatedAt ?? Infinity);
  });

  it("downloads the current Version's exact bytes and logs every content read", async () => {
    const a = await seed();
    const doc = await uploaded(a, "10p.pdf");
    const res = await as(a, `/api/documents/${doc.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="10p.pdf"; filename*=UTF-8''10p.pdf`,
    );
    expect(await sha256(await res.arrayBuffer())).toBe(await sha256(fixture("10p.pdf")));
    await (await as(a, `/api/documents/${doc.id}/versions/1/content`)).arrayBuffer();

    expect(await accessLog(a.tenantId)).toEqual([
      {
        action: "read-content",
        resource: `document ${doc.id} v1`,
        status: 200,
        actorUserId: a.userId,
        at: expect.any(Number) as number,
      },
      {
        action: "read-content",
        resource: `document ${doc.id} v1`,
        status: 200,
        actorUserId: a.userId,
        at: expect.any(Number) as number,
      },
    ]);
  });

  it("returns a Document by id and 404 (logged) for one it does not have", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    expect(await body(await as(a, `/api/documents/${doc.id}`))).toEqual({ document: doc });
    expect((await as(a, "/api/documents/doc_missing")).status).toBe(404);
    expect((await accessLog(a.tenantId)).map((e) => [e.action, e.status])).toEqual([["read", 404]]);
  });
});

describe("folders", () => {
  it("creates, nests, renames and deletes empty folders, and moves Documents between them", async () => {
    const a = await seed();
    const contracts = await folder(a, "Contracts");
    const y2026 = await folder(a, "2025", contracts.id);
    expect(y2026.parentId).toBe(contracts.id);

    const renamed = await as(a, `/api/folders/${y2026.id}`, json("PATCH", { name: "2026" }));
    expect(await body<{ folder: FolderInfo }>(renamed)).toMatchObject({
      folder: { id: y2026.id, name: "2026", parentId: contracts.id },
    });
    const { folders } = await body<{ folders: FolderInfo[] }>(await as(a, "/api/folders"));
    expect(folders.map((f) => f.name)).toEqual(["2026", "Contracts"]);

    const doc = await uploaded(a, "tiny.pdf");
    const moved = await as(a, `/api/documents/${doc.id}`, json("PATCH", { folderId: y2026.id }));
    expect(moved.status).toBe(200);
    const list = async (folderId?: string) =>
      (
        await body<{ documents: DocumentInfo[] }>(
          await as(a, `/api/documents${folderId ? `?folderId=${folderId}` : ""}`),
        )
      ).documents.map((d) => d.id);
    expect(await list(y2026.id)).toEqual([doc.id]);
    expect(await list()).toEqual([]);

    expect((await as(a, `/api/folders/${contracts.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await as(a, `/api/folders/${y2026.id}`, { method: "DELETE" })).status).toBe(409);
    await as(a, `/api/documents/${doc.id}`, json("PATCH", { folderId: null }));
    expect(await list()).toEqual([doc.id]);
    expect((await as(a, `/api/folders/${y2026.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await as(a, `/api/folders/${contracts.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await body(await as(a, "/api/folders"))).toEqual({ folders: [] });
  });

  it("refuses to move a folder inside itself", async () => {
    const a = await seed();
    const top = await folder(a, "Top");
    const inner = await folder(a, "Inner", top.id);
    const res = await as(a, `/api/folders/${top.id}`, json("PATCH", { parentId: inner.id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict" });
    expect(
      (await as(a, `/api/folders/${top.id}`, json("PATCH", { parentId: top.id }))).status,
    ).toBe(409);
  });

  it("deletes a folder whose only Documents are in Trash, and they restore to the top level", async () => {
    const a = await seed();
    const f = await folder(a, "Old");
    const doc = await uploaded(a, "tiny.pdf", { folderId: f.id });
    await as(a, `/api/documents/${doc.id}`, { method: "DELETE" });
    expect((await as(a, `/api/folders/${f.id}`, { method: "DELETE" })).status).toBe(204);
    await as(a, `/api/documents/${doc.id}/restore`, { method: "POST" });
    expect(await body(await as(a, `/api/documents/${doc.id}`))).toMatchObject({
      document: { folderId: null, deletedAt: null },
    });
  });

  it("rejects a bad request body with 422 invalid_input", async () => {
    const a = await seed();
    const res = await as(a, "/api/folders", json("POST", { name: "" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_input" });
  });
});

describe("versions", () => {
  it("lists 3 Versions and Restore v1 creates v4 with v1's bytes", async () => {
    const a = await seed();
    const doc = await uploaded(a, "10p.pdf");
    for (const name of ["tiny.pdf", "rotated.pdf"]) {
      const res = await as(a, `/api/documents/${doc.id}/versions`, {
        method: "POST",
        body: fixture(name),
      });
      expect(res.status).toBe(201);
    }
    const before = await body<{ versions: VersionInfo[] }>(
      await as(a, `/api/documents/${doc.id}/versions`),
    );
    expect(before.versions.map((v) => [v.n, v.pages])).toEqual([
      [3, 3],
      [2, 1],
      [1, 10],
    ]);

    const restored = await as(a, `/api/documents/${doc.id}/versions/1/restore`, { method: "POST" });
    expect(restored.status).toBe(201);
    expect(await body(restored)).toMatchObject({
      document: { currentVersion: 4, pages: 10, sha256: await sha256(fixture("10p.pdf")) },
    });
    const content = await as(a, `/api/documents/${doc.id}/content`);
    expect(await sha256(await content.arrayBuffer())).toBe(await sha256(fixture("10p.pdf")));
    const after = await body<{ versions: VersionInfo[] }>(
      await as(a, `/api/documents/${doc.id}/versions`),
    );
    expect(after.versions.map((v) => v.n)).toEqual([4, 3, 2, 1]);
    expect(
      (await as(a, `/api/documents/${doc.id}/versions/9/restore`, { method: "POST" })).status,
    ).toBe(404);
  });

  it("refuses a malformed new Version and keeps the current one", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const res = await as(a, `/api/documents/${doc.id}/versions`, {
      method: "POST",
      body: fixture("malformed.pdf"),
    });
    expect(res.status).toBe(422);
    expect(await body(await as(a, `/api/documents/${doc.id}`))).toEqual({ document: doc });
    expect(await listTenantObjectKeys(a.tenantId, env)).toHaveLength(1);
  });
});

describe("trash", () => {
  it("moves a Document to Trash, hides it from lists, and restores it", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const deleted = await as(a, `/api/documents/${doc.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await body(await as(a, "/api/documents"))).toEqual({ documents: [] });
    const trash = await body<{ documents: DocumentInfo[] }>(await as(a, "/api/documents?trash=1"));
    expect(trash.documents.map((d) => d.id)).toEqual([doc.id]);
    expect(trash.documents[0]?.deletedAt).toEqual(expect.any(Number));

    const restored = await as(a, `/api/documents/${doc.id}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect(
      (await body<{ documents: DocumentInfo[] }>(await as(a, "/api/documents"))).documents.map(
        (d) => d.id,
      ),
    ).toEqual([doc.id]);
    expect(await body(await as(a, "/api/documents?trash=1"))).toEqual({ documents: [] });
  });
});

describe("cross-tenant", () => {
  it("does not let A see, change or file into B's Documents and folders", async () => {
    const a = await seed();
    const b = await seed();
    const docA = await uploaded(a, "tiny.pdf");
    const docB = await uploaded(b, "tiny.pdf");
    const folderB = await folder(b, "B's");
    const statuses = [
      (await as(a, `/api/documents/${docB.id}`)).status,
      (await as(a, `/api/documents/${docB.id}/content`)).status,
      (await as(a, `/api/documents/${docB.id}`, json("PATCH", { title: "x" }))).status,
      (await as(a, `/api/documents/${docA.id}`, json("PATCH", { folderId: folderB.id }))).status,
      (await as(a, `/api/documents?folderId=${folderB.id}`)).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
    expect(await body(await as(a, `/api/documents/${docA.id}`))).toMatchObject({
      document: { folderId: null },
    });
    expect(await body(await as(b, `/api/documents/${docB.id}`))).toEqual({ document: docB });
  });
});
