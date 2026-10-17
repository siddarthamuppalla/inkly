import { AppError } from "@inkly/domain";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  deletePages,
  fillForm,
  inspect,
  merge,
  pageNumber,
  readFormFields,
  reorder,
  rotate,
  split,
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

  it("throws AppError for non-PDF bytes", async () => {
    await expect(inspect(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(AppError);
  });
});
