import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@inkly/domain";
import { verifyFile } from "@inkly/testing";
import { degrees, PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { MAX_SIGNATURE_BYTES, stampFields, type StampField } from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(corpus, name)));
const out = mkdtempSync(join(tmpdir(), "inkly-stamp-test-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

/** A 2×1 PNG in --link blue (#1a47c2). */
const BLUE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGOQcj8k5X4IAAasAkez8fvzAAAAAElFTkSuQmCC";

let n = 0;
function save(bytes: Uint8Array): string {
  const file = join(out, `stamped-${String(++n)}.pdf`);
  writeFileSync(file, bytes);
  return file;
}

function pageText(bytes: Uint8Array, page: number): string {
  const p = String(page);
  return execFileSync("pdftotext", ["-f", p, "-l", p, save(bytes), "-"], { encoding: "utf8" });
}

interface Word {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Words of `page` with their boxes on the displayed page, from `pdftotext -bbox`. */
function words(bytes: Uint8Array, page: number): Word[] {
  const p = String(page);
  const html = execFileSync("pdftotext", ["-bbox", "-f", p, "-l", p, save(bytes), "-"], {
    encoding: "utf8",
  });
  return [
    ...html.matchAll(/xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</g),
  ].map((m) => ({
    text: m[5] ?? "",
    x0: Number(m[1]),
    y0: Number(m[2]),
    x1: Number(m[3]),
    y1: Number(m[4]),
  }));
}

/** Renders page `page` at 18 dpi and returns the RGB of the pixel at fraction (fx, fy). */
function pixel(bytes: Uint8Array, page: number, fx: number, fy: number): [number, number, number] {
  const p = String(page);
  const ppm = execFileSync("pdftoppm", ["-cropbox", "-r", "18", "-f", p, "-l", p, save(bytes)]);
  const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 40).toString("latin1"));
  if (!header) throw new Error("pdftoppm did not write a PPM");
  const [w, h] = [Number(header[1]), Number(header[2])];
  const i = header[0].length + (Math.floor(fy * h) * w + Math.floor(fx * w)) * 3;
  return [ppm[i] ?? 0, ppm[i + 1] ?? 0, ppm[i + 2] ?? 0];
}

const field = (f: Partial<StampField> & Pick<StampField, "kind" | "value">): StampField => ({
  page: 1,
  x: 0.1,
  y: 0.1,
  w: 0.4,
  h: 0.05,
  ...f,
});

describe("stampFields", () => {
  it("draws text and dates into the page text and keeps a valid PDF", async () => {
    const bytes = await stampFields(fixture("10p.pdf"), [
      field({ kind: "text", value: "Ana Ruiz, Director" }),
      field({ kind: "date", page: 3, y: 0.5, value: "2026-10-18" }),
      field({ kind: "signature", y: 0.3, h: 0.1, value: BLUE_PNG }),
      field({ kind: "initials", page: 2, w: 0.1, value: BLUE_PNG }),
      field({ kind: "checkbox", y: 0.6, w: 0.04, h: 0.03, value: "true" }),
      field({ kind: "checkbox", y: 0.7, w: 0.04, h: 0.03, value: "false" }),
    ]);
    const verified = verifyFile(save(bytes), { expectPages: 10 });
    expect(verified.failures).toEqual([]);
    expect(pageText(bytes, 1)).toContain("Ana Ruiz, Director");
    expect(pageText(bytes, 3)).toContain("2026-10-18");
    expect(pageText(bytes, 2)).not.toContain("2026-10-18");
  });

  it("fills its rect with the signature image and draws a checkmark only when checked", async () => {
    const bytes = await stampFields(fixture("tiny.pdf"), [
      field({ kind: "signature", x: 0.1, y: 0.1, w: 0.3, h: 0.15, value: BLUE_PNG }),
      field({ kind: "checkbox", x: 0.6, y: 0.6, w: 0.3, h: 0.3, value: "true" }),
      field({ kind: "checkbox", x: 0.1, y: 0.6, w: 0.3, h: 0.3, value: "false" }),
    ]);
    const [r, g, b] = pixel(bytes, 1, 0.25, 0.175);
    expect(b - r, `signature centre is rgb(${String([r, g, b])})`).toBeGreaterThan(120);
    const check = pixel(bytes, 1, 0.6 + 0.42 * 0.3, 0.6 + 0.78 * 0.3 - 0.01);
    expect(Math.max(...check), `checkmark is rgb(${String(check)})`).toBeLessThan(128);
    expect(pixel(bytes, 1, 0.1 + 0.42 * 0.3, 0.6 + 0.78 * 0.3 - 0.01)).toEqual([255, 255, 255]);
  });

  it.each([1, 2, 3])("draws upright on displayed page %i of rotated.pdf", async (page) => {
    const bytes = await stampFields(fixture("rotated.pdf"), [
      field({ kind: "signature", page, x: 0, y: 0, w: 0.5, h: 0.5, value: BLUE_PNG }),
      field({ kind: "text", page, x: 0.55, y: 0.8, w: 0.4, h: 0.06, value: "Upright" }),
    ]);
    const [r, , b] = pixel(bytes, page, 0.25, 0.25);
    expect(b - r, "top-left quadrant is blue").toBeGreaterThan(120);
    const [r2, , b2] = pixel(bytes, page, 0.75, 0.6);
    expect(Math.abs(b2 - r2), "right of the image stays unmarked").toBeLessThan(20);

    const word = words(bytes, page).find((w) => w.text === "Upright");
    if (!word) throw new Error("stamped text is missing from the page text");
    expect(word.x1 - word.x0, "the word runs left to right").toBeGreaterThan(word.y1 - word.y0);
  });

  it.each([0, 90, 180, 270])("respects an offset CropBox rotated %i degrees", async (angle) => {
    const source = await PDFDocument.create();
    const page = source.addPage([600, 800]);
    page.setCropBox(40, 50, 400, 600);
    page.setRotation(degrees(angle));
    const bytes = await stampFields(await source.save(), [
      field({ kind: "signature", x: 0, y: 0, w: 0.5, h: 0.5, value: BLUE_PNG }),
    ]);
    const [r, , b] = pixel(bytes, 1, 0.2, 0.2);
    expect(b - r, "top-left of the displayed CropBox is blue").toBeGreaterThan(120);
    const [r2, , b2] = pixel(bytes, 1, 0.8, 0.8);
    expect(Math.abs(b2 - r2), "bottom-right stays unmarked").toBeLessThan(20);
  });

  it("substitutes characters Helvetica cannot draw instead of throwing", async () => {
    const bytes = await stampFields(fixture("tiny.pdf"), [
      field({ kind: "text", value: "Zoë Łukasz 王 ✓\nNext" }),
    ]);
    expect(pageText(bytes, 1)).toContain("Zoë ?ukasz ? ? Next");
  });

  it("refuses a Field off its page, an unknown page, or a bad signature image", async () => {
    const tiny = fixture("tiny.pdf");
    const refused = [
      [field({ kind: "text", page: 2, value: "x" })],
      [field({ kind: "text", x: 0.8, w: 0.3, value: "x" })],
      [field({ kind: "text", w: 0, value: "x" })],
      [field({ kind: "signature", value: "data:image/jpeg;base64,AAAA" })],
      [field({ kind: "signature", value: "data:image/png;base64,AAAAAAAAAAAA" })],
      [field({ kind: "signature", value: "data:image/png;base64,iVBORw0KGgoAAAAAAAAAAAAAAA==" })],
    ];
    for (const fields of refused) {
      await expect(stampFields(tiny, fields)).rejects.toBeInstanceOf(AppError);
    }
  });

  it("refuses a signature image over the size limit", async () => {
    const big = new Uint8Array(MAX_SIGNATURE_BYTES + 1);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const url = `data:image/png;base64,${Buffer.from(big).toString("base64")}`;
    await expect(
      stampFields(fixture("tiny.pdf"), [field({ kind: "signature", value: url })]),
    ).rejects.toMatchObject({ code: "invalid_input", message: /limit/ });
  });
});
