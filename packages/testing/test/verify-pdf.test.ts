import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { verifyCorpus, verifyFile } from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string) => join(corpus, name);

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "verify-pdf-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("verifyFile", () => {
  it("passes a valid fixture and reports pages, sizes and rotation", () => {
    const r = verifyFile(fixture("rotated.pdf"));
    expect(r.ok).toBe(true);
    expect(r.lines).toContain("qpdf ok");
    expect(r.lines).toContain("pages: 3");
    expect(r.lines).toContain("page 2: 595.276 x 841.89 pt, rotation 90");
  });

  it("fails a malformed PDF and names the qpdf error", () => {
    const r = verifyFile(fixture("malformed.pdf"));
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/^qpdf error: .*damaged/);
  });

  it("fails when --expect-pages does not match", () => {
    expect(verifyFile(fixture("10p.pdf"), { expectPages: 10 }).ok).toBe(true);
    const r = verifyFile(fixture("10p.pdf"), { expectPages: 9 });
    expect(r.ok).toBe(false);
    expect(r.failures).toContain("expected 9 pages, found 10");
  });
});

describe("golden comparison", () => {
  it("passes against a golden rendered from the same PDF", () => {
    const golden = join(tempDir(), "tiny");
    expect(verifyFile(fixture("tiny.pdf"), { golden, updateGolden: true }).ok).toBe(true);
    const r = verifyFile(fixture("tiny.pdf"), { golden });
    expect(r.ok).toBe(true);
    expect(r.lines).toContain("page 1: visual diff 0.000% (≤ 0.1%)");
  });

  it("fails when the render differs from the golden beyond the threshold", () => {
    const golden = join(tempDir(), "forms");
    verifyFile(fixture("forms.pdf"), { golden, updateGolden: true });
    const r = verifyFile(fixture("tiny.pdf"), { golden });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/^page 1: visual diff [\d.]+% > 0\.1%$/);
    expect(verifyFile(fixture("tiny.pdf"), { golden, threshold: 100 }).ok).toBe(true);
  });

  it("fails when the page count differs from the golden", () => {
    const golden = join(tempDir(), "rotated");
    verifyFile(fixture("rotated.pdf"), { golden, updateGolden: true });
    const r = verifyFile(fixture("tiny.pdf"), { golden, threshold: 100 });
    expect(r.ok).toBe(false);
    expect(r.failures).toContain("golden has 3 page(s), render has 1");
  });
});

describe("verifyCorpus", () => {
  it("matches every fixture in fixtures/pdfs, counting malformed as an expected failure", () => {
    const { ok, rows } = verifyCorpus(corpus);
    expect(rows.map((r) => [r.file, r.pass])).toEqual([
      ["10p.pdf", true],
      ["50p.pdf", true],
      ["encrypted.pdf", true],
      ["forms.pdf", true],
      ["huge-image.pdf", true],
      ["malformed.pdf", true],
      ["rotated.pdf", true],
      ["scanned.pdf", true],
      ["tiny.pdf", true],
    ]);
    expect(ok).toBe(true);
  });
});
