import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type Annotation, type AnnotationShape } from "@inkly/domain";
import { verifyFile } from "@inkly/testing";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { withAnnotations } from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(corpus, name)));
const out = mkdtempSync(join(tmpdir(), "inkly-annotate-test-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

let n = 0;
function annotation(shape: AnnotationShape, comments: string[] = []): Annotation {
  n += 1;
  return {
    id: `a${String(n)}`,
    shape,
    version: 1,
    author: { id: "u1", name: "Ada" },
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    resolvedAt: null,
    comments: comments.map((text, i) => ({
      id: `c${String(i)}`,
      author: { id: "u2", name: "Bo" },
      text,
      createdAt: 1_760_000_000_000 + i,
    })),
  };
}

const highlight = (page: number, x = 0.1, y = 0.1, w = 0.3, h = 0.05) =>
  annotation({ kind: "highlight", page, color: "yellow", rects: [{ x, y, w, h }] }, ["Agreed"]);
const note = annotation({
  kind: "note",
  page: 2,
  color: "blue",
  at: { x: 0.5, y: 0.5 },
  text: "Check the date",
});
const ink = annotation({
  kind: "ink",
  page: 3,
  color: "red",
  strokes: [
    [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.8 },
    ],
  ],
});

interface ReadAnnot {
  subtype: string;
  rect: number[];
  contents: string;
  author: string;
}

async function annotsOf(bytes: Uint8Array, page: number): Promise<ReadAnnot[]> {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(page - 1).node.Annots();
  if (!annots) return [];
  return annots.asArray().map((ref) => {
    const dict = doc.context.lookup(ref, PDFDict);
    const text = (key: string) => {
      const v = dict.get(PDFName.of(key));
      return v && "decodeText" in v ? (v as { decodeText(): string }).decodeText() : "";
    };
    return {
      subtype: dict.lookup(PDFName.of("Subtype"), PDFName).decodeText(),
      rect: dict
        .lookup(PDFName.of("Rect"), PDFArray)
        .asArray()
        .map((x) => (x as PDFNumber).asNumber()),
      contents: text("Contents"),
      author: text("T"),
    };
  });
}

/** Renders page `page` at 18 dpi and returns the RGB of the pixel at fraction (fx, fy). */
function pixel(bytes: Uint8Array, page: number, fx: number, fy: number): [number, number, number] {
  const file = join(out, `render-${String(++n)}.pdf`);
  writeFileSync(file, bytes);
  const p = String(page);
  const ppm = execFileSync("pdftoppm", ["-r", "18", "-f", p, "-l", p, file]);
  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 40).toString("latin1"));
  if (!header) throw new Error("pdftoppm did not write a PPM");
  const [w, h] = [Number(header[1]), Number(header[2])];
  const start = header[0].length;
  const i = start + (Math.floor(fy * h) * w + Math.floor(fx * w)) * 3;
  return [ppm[i] ?? 0, ppm[i + 1] ?? 0, ppm[i + 2] ?? 0];
}

describe("withAnnotations", () => {
  it("writes highlights, notes and ink as PDF annotations and keeps every page", async () => {
    const source = fixture("10p.pdf");
    const bytes = await withAnnotations(source, [highlight(1), note, ink]);

    const file = join(out, "annotated.pdf");
    writeFileSync(file, bytes);
    const verified = verifyFile(file, { expectPages: 10 });
    expect(verified.failures).toEqual([]);
    expect(verified.ok).toBe(true);

    expect(await annotsOf(bytes, 1)).toMatchObject([
      { subtype: "Highlight", contents: "Bo: Agreed", author: "Ada" },
    ]);
    expect(await annotsOf(bytes, 2)).toMatchObject([
      { subtype: "Text", contents: "Check the date", author: "Ada" },
    ]);
    expect((await annotsOf(bytes, 3)).map((a) => a.subtype)).toEqual(["Ink"]);
    expect(await annotsOf(bytes, 4)).toEqual([]);
  });

  it("places geometry in PDF user space from the top-left of the page", async () => {
    const bytes = await withAnnotations(fixture("10p.pdf"), [highlight(1, 0.1, 0.1, 0.3, 0.05)]);
    const [rect] = await annotsOf(bytes, 1);
    const [w, h] = [595.276, 841.89];
    expect(rect?.rect[0]).toBeCloseTo(0.1 * w, 1);
    expect(rect?.rect[1]).toBeCloseTo(h - 0.15 * h, 1);
    expect(rect?.rect[2]).toBeCloseTo(0.4 * w, 1);
    expect(rect?.rect[3]).toBeCloseTo(h - 0.1 * h, 1);
  });

  it.each([1, 2, 3])(
    "draws a highlight where it was placed on displayed page %i of rotated.pdf",
    async (page) => {
      const bytes = await withAnnotations(fixture("rotated.pdf"), [
        annotation({
          kind: "highlight",
          page,
          color: "blue",
          rects: [{ x: 0, y: 0, w: 0.5, h: 0.5 }],
        }),
      ]);
      const [r, g, b] = pixel(bytes, page, 0.25, 0.25);
      expect(b - r, `top-left quadrant is rgb(${String([r, g, b])})`).toBeGreaterThan(40);
      const [r2, , b2] = pixel(bytes, page, 0.75, 0.75);
      expect(Math.abs(b2 - r2), "bottom-right quadrant stays unmarked").toBeLessThan(20);
    },
  );

  it("refuses an Annotation on a page the PDF does not have", async () => {
    await expect(withAnnotations(fixture("tiny.pdf"), [highlight(2)])).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("returns a valid PDF unchanged in page count when there are no annotations", async () => {
    const bytes = await withAnnotations(fixture("tiny.pdf"), []);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});
