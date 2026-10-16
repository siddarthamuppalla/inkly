import { AppError } from "@inkly/domain";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  deletePages,
  inspect,
  merge,
  pageNumber,
  reorder,
  rotate,
  split,
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

  it("throws AppError for non-PDF bytes", async () => {
    await expect(inspect(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(AppError);
  });
});
