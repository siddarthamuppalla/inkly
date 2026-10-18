import { AppError } from "@inkly/domain";
import { PDFDocument } from "pdf-lib";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";

import {
  appendCertificate,
  deletePages,
  fillForm,
  generateSealKey,
  importSealKey,
  inspect,
  merge,
  pageNumber,
  readFormFields,
  reorder,
  rotate,
  sealPdf,
  split,
  stampFields,
  withAnnotations,
} from "../../src/index.ts";

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 100 + i]);
  return doc.save();
}

describe("page ops inside the Workers runtime", () => {
  it("run every op on bytes", async () => {
    const merged = await merge([await pdf(2), await pdf(3)]);
    expect((await inspect(merged)).pages).toBe(5);

    const rotated = await rotate(merged, [pageNumber(1)], 90);
    const reordered = await reorder(rotated, [5, 4, 3, 2, 1].map(pageNumber));
    const trimmed = await deletePages(reordered, [pageNumber(1)]);
    const parts = await split(trimmed, [{ from: pageNumber(1), to: pageNumber(2) }]);

    const info = await inspect(parts[0] ?? new Uint8Array());
    expect(info).toMatchObject({ pages: 2, encrypted: false });
    expect(info.sizes.map((s) => s.height)).toEqual([101, 100]);
  });

  it("reads, fills and flattens a form", async () => {
    const doc = await PDFDocument.create();
    doc
      .getForm()
      .createTextField("name")
      .addToPage(doc.addPage(), { x: 10, y: 10, width: 200, height: 20 });
    const filled = await fillForm(await doc.save(), { name: "Ada" }, { flatten: false });
    expect((await readFormFields(filled)).map((f) => [f.name, f.value])).toEqual([["name", "Ada"]]);
    const flat = await fillForm(filled, {}, { flatten: true });
    expect(await readFormFields(flat)).toEqual([]);
  });

  it("adds annotations to bytes", async () => {
    const out = await withAnnotations(await pdf(1), [
      {
        id: "a1",
        shape: { kind: "note", page: 1, color: "yellow", at: { x: 0.5, y: 0.5 }, text: "Hi" },
        version: 1,
        author: { id: "u1", name: "Ada" },
        createdAt: 0,
        updatedAt: 0,
        resolvedAt: null,
        comments: [],
      },
    ]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPage(0).node.Annots()?.size()).toBe(1);
  });

  it("stamps, certifies and seals with WebCrypto", async () => {
    const key = await generateSealKey();
    const stamped = await stampFields(await pdf(1), [
      { kind: "text", page: 1, x: 0.1, y: 0.1, w: 0.8, h: 0.2, value: "Ada" },
      { kind: "checkbox", page: 1, x: 0.1, y: 0.5, w: 0.1, h: 0.2, value: "true" },
    ]);
    const certified = await appendCertificate(stamped, {
      envelopeId: "env_1",
      title: "NDA",
      documentSha256: "0".repeat(64),
      sentAt: 0,
      completedAt: 60_000,
      sender: { name: "Ada", email: "ada@example.com" },
      recipients: [],
      events: [{ seq: 1, at: 0, actor: "Ada", action: "created", hash: "a".repeat(64) }],
    });
    const imported = await importSealKey(key.privateKeyPem, key.certificatePem);
    const sealed = await sealPdf(certified, imported);
    expect((await inspect(sealed)).pages).toBe(2);

    const text = new TextDecoder("latin1").decode(sealed);
    const range = /\/ByteRange \[0 (\d+) (\d+) (\d+) *\]/.exec(text)?.slice(1).map(Number);
    const [start = 0, resume = 0, rest = 0] = range ?? [];
    expect(resume + rest).toBe(sealed.length);
    const signed = new Uint8Array(start + rest);
    signed.set(sealed.subarray(0, start));
    signed.set(sealed.subarray(resume), start);
    const hex = text.slice(start + 1, resume - 1);
    const der = Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
    const cms = new pkijs.SignedData({
      schema: pkijs.ContentInfo.fromBER(der.buffer).content,
    });
    expect(await cms.verify({ signer: 0, data: signed.buffer, checkChain: false })).toBe(true);
    signed[10] = (signed[10] ?? 0) ^ 1;
    await expect(
      cms.verify({ signer: 0, data: signed.buffer, checkChain: false }),
    ).rejects.toThrow();
  });

  it("throws AppError for non-PDF bytes", async () => {
    await expect(inspect(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(AppError);
  });
});
