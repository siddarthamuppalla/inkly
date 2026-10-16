import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type AppErrorCode } from "@inkly/domain";
import { verifyFile } from "@inkly/testing";
import { afterAll, describe, expect, it } from "vitest";

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
  type PageNumber,
} from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(corpus, name)));
const out = mkdtempSync(join(tmpdir(), "inkly-pdf-test-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

const p = (...ns: number[]): PageNumber[] => ns.map(pageNumber);

let written = 0;
/** Writes `bytes` to the temp dir, runs verify-pdf on it and returns the page rotations. */
function verified(bytes: Uint8Array, expectPages: number): number[] {
  const file = join(out, `out-${String(++written)}.pdf`);
  writeFileSync(file, bytes);
  const r = verifyFile(file, { expectPages });
  expect(r.failures).toEqual([]);
  expect(r.ok).toBe(true);
  return (r.info?.pageInfo ?? []).map((pg) => pg.rotation);
}

function pageText(bytes: Uint8Array, page: number): string {
  const file = join(out, `text-${String(++written)}.pdf`);
  writeFileSync(file, bytes);
  const n = String(page);
  return execFileSync("pdftotext", ["-f", n, "-l", n, file, "-"], { encoding: "utf8" });
}

async function rejection(promise: Promise<unknown>): Promise<AppErrorCode> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  throw new Error("expected the operation to fail");
}

/** Serializes `objects` (numbered from 1, object 1 the catalog) with a correct xref table. */
function pdfFrom(objects: readonly string[]): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A valid PDF with `count` blank 100 x 100 pt pages. */
function blankPdf(count: number): Uint8Array {
  const kids = Array.from({ length: count }, (_, i) => `${String(i + 3)} 0 R`).join(" ");
  return pdfFrom([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${String(count)} >>`,
    ...Array.from(
      { length: count },
      () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    ),
  ]);
}

describe("pageNumber", () => {
  it("accepts positive integers and refuses anything else with invalid_input", () => {
    expect(pageNumber(1)).toBe(1);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pageNumber(bad)).toThrow(AppError);
    }
  });
});

describe("inspect", () => {
  it("reports pages and page sizes of a valid PDF", async () => {
    const info = await inspect(fixture("10p.pdf"));
    expect(info.pages).toBe(10);
    expect(info.encrypted).toBe(false);
    expect(info.sizes).toHaveLength(10);
    expect(info.sizes[0]?.width).toBeCloseTo(595.28, 1);
    expect(info.sizes[0]?.height).toBeCloseTo(841.89, 1);
  });

  it("reports an encrypted PDF instead of failing", async () => {
    const info = await inspect(fixture("encrypted.pdf"));
    expect(info).toMatchObject({ pages: 2, encrypted: true });
  });

  it("refuses an encrypted PDF whose page tree is in encrypted object streams", async () => {
    expect(await rejection(inspect(fixture("encrypted-objstm.pdf")))).toBe("pdf_encrypted");
  });

  it("refuses malformed input and non-PDF bytes", async () => {
    expect(await rejection(inspect(fixture("malformed.pdf")))).toBe("pdf_malformed");
    expect(await rejection(inspect(new TextEncoder().encode("hello")))).toBe("pdf_malformed");
    expect(await rejection(inspect(new Uint8Array()))).toBe("pdf_malformed");
    const headless = new TextEncoder().encode("not a pdf\nstartxref\n0\n%%EOF\n");
    expect(await rejection(inspect(headless))).toBe("pdf_malformed");
  });

  it("refuses input above the byte ceiling without parsing it", async () => {
    const big = new Uint8Array(MAX_WORKER_BYTES + 1);
    expect(await rejection(inspect(big))).toBe("too_large_for_worker");
  });
});

describe("merge", () => {
  it("concatenates documents and keeps each page's rotation", async () => {
    const bytes = await merge([fixture("10p.pdf"), fixture("rotated.pdf"), fixture("tiny.pdf")]);
    const rotations = verified(bytes, 14);
    expect(rotations.slice(10)).toEqual([0, 90, 270, 0]);
  });

  it("merges the image and form fixtures", async () => {
    verified(await merge([fixture("scanned.pdf"), fixture("forms.pdf")]), 3);
  });

  it("needs at least two inputs", async () => {
    expect(await rejection(merge([fixture("tiny.pdf")]))).toBe("invalid_input");
  });

  it("refuses when the combined input is above the page ceiling", async () => {
    const inputs = Array.from({ length: 5 }, () => fixture("50p.pdf"));
    expect(await rejection(merge(inputs))).toBe("too_large_for_worker");
  });

  it("refuses an encrypted or malformed input", async () => {
    expect(await rejection(merge([fixture("tiny.pdf"), fixture("encrypted.pdf")]))).toBe(
      "pdf_encrypted",
    );
    expect(await rejection(merge([fixture("malformed.pdf"), fixture("tiny.pdf")]))).toBe(
      "pdf_malformed",
    );
  });
});

describe("split", () => {
  it("returns one PDF per range, ranges inclusive", async () => {
    const parts = await split(fixture("50p.pdf"), [
      { from: pageNumber(1), to: pageNumber(10) },
      { from: pageNumber(11), to: pageNumber(11) },
      { from: pageNumber(12), to: pageNumber(50) },
    ]);
    expect(parts).toHaveLength(3);
    expect(parts.map((part, i) => verified(part, [10, 1, 39][i] ?? 0).length)).toEqual([10, 1, 39]);
  });

  it("keeps rotation of the pages it extracts", async () => {
    const [part] = await split(fixture("rotated.pdf"), [
      { from: pageNumber(2), to: pageNumber(3) },
    ]);
    expect(verified(part ?? new Uint8Array(), 2)).toEqual([90, 270]);
  });

  it("refuses empty, reversed and out-of-range ranges", async () => {
    const doc = fixture("10p.pdf");
    expect(await rejection(split(doc, []))).toBe("invalid_input");
    expect(await rejection(split(doc, [{ from: pageNumber(5), to: pageNumber(4) }]))).toBe(
      "invalid_input",
    );
    expect(await rejection(split(doc, [{ from: pageNumber(9), to: pageNumber(11) }]))).toBe(
      "invalid_input",
    );
  });
});

describe("rotate", () => {
  it("adds to the existing rotation of the named pages only", async () => {
    const bytes = await rotate(fixture("rotated.pdf"), p(1, 2, 3), 90);
    expect(verified(bytes, 3)).toEqual([90, 180, 0]);
    const again = await rotate(bytes, p(2), -270);
    expect(verified(again, 3)).toEqual([90, 270, 0]);
  });

  it("keeps the form of forms.pdf", async () => {
    const file = join(out, "rotated-form.pdf");
    writeFileSync(file, await rotate(fixture("forms.pdf"), p(1), 180));
    const r = verifyFile(file, { expectPages: 1 });
    expect(r.ok).toBe(true);
    expect(r.info?.form).toBe(true);
    expect(r.info?.pageInfo[0]?.rotation).toBe(180);
  });

  it("refuses degrees that are not a multiple of 90, and bad pages", async () => {
    const doc = fixture("10p.pdf");
    expect(await rejection(rotate(doc, p(1), 45))).toBe("invalid_input");
    expect(await rejection(rotate(doc, p(11), 90))).toBe("invalid_input");
    expect(await rejection(rotate(doc, [], 90))).toBe("invalid_input");
  });

  it("refuses encrypted input", async () => {
    expect(await rejection(rotate(fixture("encrypted.pdf"), p(1), 90))).toBe("pdf_encrypted");
  });
});

describe("reorder", () => {
  it("puts pages in the given order", async () => {
    const bytes = await reorder(fixture("rotated.pdf"), p(3, 1, 2));
    expect(verified(bytes, 3)).toEqual([270, 0, 90]);
  });

  it("moves each page's text with it", async () => {
    const bytes = await reorder(fixture("10p.pdf"), p(10, 9, 8, 7, 6, 5, 4, 3, 2, 1));
    verified(bytes, 10);
    expect(pageText(bytes, 1)).toContain("Page 10 of 10");
    expect(pageText(bytes, 10)).toContain("Page 1 of 10");
  });

  it("refuses an order that is not a permutation of every page", async () => {
    const doc = fixture("rotated.pdf");
    expect(await rejection(reorder(doc, p(1, 2)))).toBe("invalid_input");
    expect(await rejection(reorder(doc, p(1, 1, 2)))).toBe("invalid_input");
    expect(await rejection(reorder(doc, p(1, 2, 4)))).toBe("invalid_input");
  });
});

describe("deletePages", () => {
  it("removes the named pages and keeps the rest in order", async () => {
    const bytes = await deletePages(fixture("rotated.pdf"), p(2));
    expect(verified(bytes, 2)).toEqual([0, 270]);
    verified(await deletePages(fixture("50p.pdf"), p(1, 25, 50)), 47);
  });

  it("drops the deleted page's content from the output", async () => {
    const before = (
      await split(fixture("scanned.pdf"), [{ from: pageNumber(1), to: pageNumber(2) }])
    )[0];
    const after = await deletePages(fixture("scanned.pdf"), p(2));
    verified(after, 1);
    expect(after.length).toBeLessThan((before ?? []).length * 0.75);
  });

  it("cannot delete every page", async () => {
    expect(await rejection(deletePages(fixture("rotated.pdf"), p(1, 2, 3)))).toBe("invalid_input");
    expect(await rejection(deletePages(fixture("rotated.pdf"), []))).toBe("invalid_input");
  });
});

describe("Worker ceiling", () => {
  it("is 25 MB and 200 pages", () => {
    expect(MAX_WORKER_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_WORKER_PAGES).toBe(200);
  });

  it("allows exactly 200 pages and refuses 201", async () => {
    expect((await inspect(blankPdf(MAX_WORKER_PAGES))).pages).toBe(200);
    verified(await rotate(blankPdf(MAX_WORKER_PAGES), p(200), 90), 200);
    expect(await rejection(rotate(blankPdf(MAX_WORKER_PAGES + 1), p(1), 90))).toBe(
      "too_large_for_worker",
    );
  });

  it("refuses an op on input above the byte ceiling", async () => {
    const big = new Uint8Array(MAX_WORKER_BYTES + 1);
    expect(await rejection(rotate(big, p(1), 90))).toBe("too_large_for_worker");
  });
});

describe("malformed structure", () => {
  it("refuses a PDF with no startxref", async () => {
    const text = new TextDecoder("latin1").decode(blankPdf(1));
    const cut = new TextEncoder().encode(text.slice(0, text.indexOf("xref")) + "%%EOF\n");
    expect(await rejection(inspect(cut))).toBe("pdf_malformed");
  });

  it("refuses a PDF whose stream has no /Length", async () => {
    const bytes = pdfFrom([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
      "<< >>\nstream\n0 0 m 10 10 l S\nendstream",
    ]);
    expect(await rejection(inspect(bytes))).toBe("pdf_malformed");
  });

  it("refuses a PDF with no pages", async () => {
    expect(await rejection(inspect(blankPdf(0)))).toBe("pdf_malformed");
  });
});
