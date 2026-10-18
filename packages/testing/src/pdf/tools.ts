import { spawnSync } from "node:child_process";

export interface ToolResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runTool(
  cmd: string,
  args: readonly string[],
  install = "install qpdf and poppler-utils",
): ToolResult {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    throw new Error(`${cmd} could not run (${r.error.message}); ${install}`);
  }
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export interface PageInfo {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
}

export interface PdfInfo {
  readonly pages: number;
  readonly encrypted: boolean;
  readonly form: boolean;
  readonly pageInfo: readonly PageInfo[];
}

/** `qpdf --check`; any non-zero exit (errors 2, warnings 3) is a failure. */
export function qpdfCheck(file: string): { ok: boolean; messages: string[] } {
  const r = runTool("qpdf", ["--check", file]);
  const messages = `${r.stderr}\n${r.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(WARNING|ERROR|qpdf:)/i.test(l) || l.includes("error"));
  return { ok: r.status === 0, messages };
}

export function pdfInfo(file: string): PdfInfo {
  const head = runTool("pdfinfo", [file]);
  if (head.status !== 0) throw new Error(`pdfinfo failed: ${head.stderr.trim()}`);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(head.stdout)?.[1] ?? "0");
  const encrypted = /^Encrypted:\s+yes/m.test(head.stdout);
  const form = /^Form:\s+(AcroForm|XFA)/m.test(head.stdout);
  const detail = runTool("pdfinfo", ["-f", "1", "-l", String(pages), file]);
  const pageInfo: PageInfo[] = [];
  for (let page = 1; page <= pages; page++) {
    const size = new RegExp(`^Page\\s+${String(page)} size:\\s+([\\d.]+) x ([\\d.]+)`, "m").exec(
      detail.stdout,
    );
    const rot = new RegExp(`^Page\\s+${String(page)} rot:\\s+(\\d+)`, "m").exec(detail.stdout);
    pageInfo.push({
      page,
      width: Number(size?.[1] ?? NaN),
      height: Number(size?.[2] ?? NaN),
      rotation: Number(rot?.[1] ?? NaN),
    });
  }
  return { pages, encrypted, form, pageInfo };
}

export interface SignatureCheck {
  readonly ok: boolean;
  /** One line per signature field, as `pyhanko sign validate` prints it. */
  readonly signatures: readonly string[];
  readonly detail: string;
}

/**
 * `pyhanko sign validate` trusting only `certPem`. Passes when the file has at least one
 * signature and every one is INTACT, TRUSTED and UNTOUCHED (it covers the whole file).
 */
export function pyhankoValidate(file: string, certPem: string): SignatureCheck {
  const r = runTool(
    "pyhanko",
    ["sign", "validate", "--trust", certPem, "--trust-replace", file],
    "pip install -r .claude/skills/verify-pdf/requirements.txt",
  );
  const signatures = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const valid = (l: string) => /:INTACT:TRUSTED,UNTOUCHED$/.test(l);
  const ok = r.status === 0 && signatures.length > 0 && signatures.every(valid);
  const detail =
    signatures.length === 0 && r.status === 0
      ? "no signatures found"
      : [...signatures, r.stderr.trim()].filter((l) => l !== "").join("; ");
  return { ok, signatures, detail };
}

/** Renders every page with `pdftoppm -r 72 -png` to `${outDir}/page-N.png`. */
export function renderPages(file: string, outDir: string): void {
  const r = runTool("pdftoppm", ["-r", "72", "-png", file, `${outDir}/page`]);
  if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr.trim()}`);
}
