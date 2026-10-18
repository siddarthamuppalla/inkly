import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { diffPngs } from "./pixeldiff.ts";
import { pdfInfo, pyhankoValidate, qpdfCheck, renderPages, type PdfInfo } from "./tools.ts";

export interface Expectation {
  readonly valid: boolean;
  readonly pages?: number;
  readonly rotation?: readonly number[];
  readonly encrypted?: boolean;
  readonly form?: boolean;
}

export interface VerifyOptions {
  readonly expectPages?: number;
  readonly golden?: string;
  readonly updateGolden?: boolean;
  /** Maximum differing pixels per page, in percent. */
  readonly threshold?: number;
  /** A PEM certificate: fail unless pyHanko finds every signature intact and trusted by it. */
  readonly signed?: string;
}

export interface VerifyResult {
  readonly file: string;
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly failures: readonly string[];
  readonly info?: PdfInfo;
}

export const DEFAULT_THRESHOLD = 0.1;

function pngNames(dir: string): string[] {
  // pdftoppm zero-pads page numbers by page count; sort numerically.
  const num = (n: string) => Number(/(\d+)\.png$/.exec(n)?.[1] ?? 0);
  return readdirSync(dir)
    .filter((n) => n.endsWith(".png"))
    .sort((a, b) => num(a) - num(b));
}

function compareGolden(file: string, golden: string, threshold: number, update: boolean) {
  const lines: string[] = [];
  const failures: string[] = [];
  const work = mkdtempSync(join(tmpdir(), "verify-pdf-"));
  try {
    renderPages(file, work);
    const rendered = pngNames(work);
    if (update) {
      rmSync(golden, { recursive: true, force: true });
      mkdirSync(golden, { recursive: true });
      for (const n of rendered) copyFileSync(join(work, n), join(golden, n));
      lines.push(`golden updated: ${String(rendered.length)} page(s) written to ${golden}`);
      return { lines, failures };
    }
    if (!existsSync(golden)) {
      failures.push(`golden dir not found: ${golden}`);
      return { lines, failures };
    }
    const expected = pngNames(golden);
    if (expected.length !== rendered.length) {
      failures.push(
        `golden has ${String(expected.length)} page(s), render has ${String(rendered.length)}`,
      );
    }
    const count = Math.min(expected.length, rendered.length);
    for (let i = 0; i < count; i++) {
      const g = expected[i] ?? "";
      const r = rendered[i] ?? "";
      const d = diffPngs(readFileSync(join(golden, g)), readFileSync(join(work, r)));
      const pct = d.percent.toFixed(3);
      if (d.percent > threshold) {
        failures.push(`page ${String(i + 1)}: visual diff ${pct}% > ${String(threshold)}%`);
      } else {
        lines.push(`page ${String(i + 1)}: visual diff ${pct}% (≤ ${String(threshold)}%)`);
      }
    }
    return { lines, failures };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function verifyFile(file: string, opts: VerifyOptions = {}): VerifyResult {
  const lines: string[] = [];
  const failures: string[] = [];
  if (!existsSync(file)) {
    return { file, ok: false, lines, failures: [`file not found: ${file}`] };
  }
  const qpdf = qpdfCheck(file);
  if (!qpdf.ok) {
    const detail = qpdf.messages.length > 0 ? qpdf.messages.join("; ") : "qpdf --check failed";
    return { file, ok: false, lines, failures: [`qpdf error: ${detail}`] };
  }
  lines.push("qpdf ok");
  const info = pdfInfo(file);
  lines.push(`pages: ${String(info.pages)}${info.encrypted ? " (encrypted)" : ""}`);
  for (const p of info.pageInfo) {
    lines.push(
      `page ${String(p.page)}: ${String(p.width)} x ${String(p.height)} pt, rotation ${String(p.rotation)}`,
    );
  }
  if (opts.expectPages !== undefined && opts.expectPages !== info.pages) {
    failures.push(`expected ${String(opts.expectPages)} pages, found ${String(info.pages)}`);
  }
  if (opts.signed !== undefined) {
    const sig = pyhankoValidate(file, opts.signed);
    if (sig.ok) lines.push(...sig.signatures.map((s) => `signature ok: ${s}`));
    else failures.push(`signature invalid: ${sig.detail}`);
  }
  if (opts.golden !== undefined) {
    const g = compareGolden(
      file,
      opts.golden,
      opts.threshold ?? DEFAULT_THRESHOLD,
      opts.updateGolden ?? false,
    );
    lines.push(...g.lines);
    failures.push(...g.failures);
  }
  return { file, ok: failures.length === 0, lines, failures, info };
}

export interface CorpusRow {
  readonly file: string;
  readonly expected: string;
  readonly actual: string;
  readonly pass: boolean;
}

function describe(e: Expectation): string {
  if (!e.valid) return "invalid";
  const parts = [`${String(e.pages ?? "?")}p`];
  if (e.rotation) parts.push(`rot ${e.rotation.join("/")}`);
  if (e.encrypted) parts.push("encrypted");
  if (e.form) parts.push("form");
  return parts.join(", ");
}

function matches(e: Expectation, r: VerifyResult): string[] {
  const info = r.info;
  if (!info) return ["no info"];
  const problems: string[] = [];
  if (e.pages !== undefined && e.pages !== info.pages) problems.push(`pages ${String(info.pages)}`);
  if (e.rotation !== undefined) {
    const got = info.pageInfo.map((p) => p.rotation);
    if (got.join(",") !== e.rotation.join(",")) problems.push(`rot ${got.join("/")}`);
  }
  if ((e.encrypted ?? false) !== info.encrypted)
    problems.push(`encrypted ${String(info.encrypted)}`);
  if ((e.form ?? false) !== info.form) problems.push(`form ${String(info.form)}`);
  return problems;
}

export function verifyCorpus(dir: string): { ok: boolean; rows: CorpusRow[] } {
  const expectations = JSON.parse(readFileSync(join(dir, "expectations.json"), "utf8")) as Record<
    string,
    Expectation
  >;
  const rows: CorpusRow[] = [];
  const pdfs = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".pdf"));
  for (const name of pdfs) {
    if (!(name in expectations)) {
      rows.push({ file: name, expected: "(none)", actual: "no expectation", pass: false });
    }
  }
  for (const [name, e] of Object.entries(expectations)) {
    const r = verifyFile(join(dir, name));
    if (!e.valid) {
      rows.push({
        file: name,
        expected: describe(e),
        actual: r.ok ? "passed qpdf" : (r.failures[0] ?? "failed").slice(0, 100),
        pass: !r.ok,
      });
      continue;
    }
    const problems = r.ok ? matches(e, r) : [...r.failures];
    const info = r.info;
    const actual =
      problems.length > 0
        ? problems.join("; ")
        : info
          ? describe({
              valid: true,
              pages: info.pages,
              ...(e.rotation ? { rotation: info.pageInfo.map((p) => p.rotation) } : {}),
              encrypted: info.encrypted,
              form: info.form,
            })
          : "ok";
    rows.push({ file: basename(name), expected: describe(e), actual, pass: problems.length === 0 });
  }
  rows.sort((a, b) => a.file.localeCompare(b.file));
  return { ok: rows.every((r) => r.pass), rows };
}
