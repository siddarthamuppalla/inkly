// verify-signing's checks (T3.6): everything a sealed Envelope must satisfy, judged from what
// a client can download. Each check is named, so --self-test can prove the one it breaks fails.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_ACTIONS, AuditTrailResponse, verifyChain, type AuditEvent } from "@inkly/domain";
import { PDFDocument } from "pdf-lib";

import { pdfInfo, pyhankoValidate, qpdfCheck, runTool } from "../pdf/tools.ts";

/** What verify-signing downloads for one completed Envelope. */
export interface SignedEnvelope {
  /** `GET /api/envelopes/:id/content` once the Envelope is completed. */
  readonly signedPdf: Uint8Array;
  /** Pages of the pinned Version, from the same route before sending. */
  readonly originalPages: number;
  /** `GET /api/seal-certificate`. */
  readonly certificatePem: string;
  /** Text and date values the signers' Fields hold; each must be stamped into the pages. */
  readonly stampedText: readonly string[];
  /** `GET /api/envelopes/:id/audit`. */
  readonly audit: {
    readonly events: readonly AuditEvent[];
    readonly chain: { readonly valid: boolean; readonly head: string };
  };
}

/** `GET /api/envelopes/:id/audit`'s body, parsed; throws on an action the chain cannot hold. */
export function parseAuditTrail(body: unknown): SignedEnvelope["audit"] {
  const trail = AuditTrailResponse.parse(body);
  const events = trail.events.map((e): AuditEvent => {
    const action = AUDIT_ACTIONS.find((a) => a === e.action);
    if (!action) throw new Error(`GET …/audit has an unknown action ${e.action}`);
    // Parsed JSON, so every detail value is a JsonValue.
    return { ...e, action, detail: e.detail as AuditEvent["detail"] };
  });
  return { events, chain: trail.chain };
}

export type CheckName =
  "qpdf" | "seal" | "pages" | "stamped-text" | "audit-chain" | "completed-sha256";

export interface Check {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly detail: string;
}

export interface SigningReport {
  readonly ok: boolean;
  readonly checks: readonly Check[];
}

/** Every page of the Certificate of completion starts with this heading (packages/pdf). */
const CERTIFICATE_HEADING = "Certificate of completion";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Each page's text, in page order (pdftotext ends every page with a form feed). */
function pageTexts(file: string): string[] {
  const r = runTool("pdftotext", ["-enc", "UTF-8", file, "-"]);
  if (r.status !== 0) throw new Error(`pdftotext failed: ${r.stderr.trim()}`);
  return r.stdout.split("\f").slice(0, -1).map(squash);
}

function pagesCheck(texts: readonly string[], total: number, original: number): Check {
  const certificate = texts.flatMap((t, i) => (t.startsWith(CERTIFICATE_HEADING) ? [i] : []));
  const trailing = certificate.every((i) => i >= original);
  const ok =
    certificate.length > 0 &&
    trailing &&
    total === original + certificate.length &&
    texts.length === total;
  const detail = `${String(original)} original + ${String(certificate.length)} certificate = ${String(total)}`;
  if (ok) return { name: "pages", ok, detail };
  const why =
    certificate.length === 0
      ? "no Certificate of completion page"
      : !trailing
        ? `a certificate page sits among the original pages (${certificate.map((i) => i + 1).join(", ")})`
        : `the PDF has ${String(total)} pages`;
  return { name: "pages", ok, detail: `${why}; expected ${detail}` };
}

function auditCheck(audit: SignedEnvelope["audit"]): Check {
  const recomputed = verifyChain(audit.events);
  const ok = recomputed.valid && audit.chain.valid && recomputed.head === audit.chain.head;
  const detail = !recomputed.valid
    ? `verifyChain breaks at seq ${String(recomputed.brokenAt)}`
    : recomputed.head !== audit.chain.head
      ? `verifyChain head ${recomputed.head.slice(0, 12)}… but GET …/audit says ${audit.chain.head.slice(0, 12)}…`
      : !audit.chain.valid
        ? "GET …/audit reports the chain invalid"
        : `${String(audit.events.length)} events, head ${recomputed.head.slice(0, 12)}…`;
  return { name: "audit-chain", ok, detail };
}

function completedCheck(events: readonly AuditEvent[], signed: Uint8Array): Check {
  const last = events.at(-1);
  const actual = sha256(signed);
  if (last?.action !== "completed") {
    return {
      name: "completed-sha256",
      ok: false,
      detail: `the last event is ${String(last?.action)}, not completed`,
    };
  }
  const claimed = last.detail["sha256"];
  const said = typeof claimed === "string" ? claimed : "(none)";
  return {
    name: "completed-sha256",
    ok: claimed === actual,
    detail:
      claimed === actual
        ? `completed.sha256 = downloaded ${actual.slice(0, 12)}…`
        : `completed.sha256 ${said.slice(0, 12)}… but the download is ${actual.slice(0, 12)}…`,
  };
}

export function checkSignedEnvelope(e: SignedEnvelope): SigningReport {
  const work = mkdtempSync(join(tmpdir(), "verify-signing-"));
  try {
    const file = join(work, "signed.pdf");
    const cert = join(work, "seal.pem");
    writeFileSync(file, e.signedPdf);
    writeFileSync(cert, e.certificatePem);
    const checks: Check[] = [];

    const qpdf = qpdfCheck(file);
    checks.push({
      name: "qpdf",
      ok: qpdf.ok,
      detail: qpdf.ok ? "qpdf --check ok" : qpdf.messages.join("; ") || "qpdf --check failed",
    });

    if (!e.certificatePem.includes("-----BEGIN CERTIFICATE-----")) {
      checks.push({ name: "seal", ok: false, detail: "no seal certificate to validate against" });
    } else {
      const sig = pyhankoValidate(file, cert);
      checks.push({ name: "seal", ok: sig.ok, detail: sig.detail || sig.signatures.join("; ") });
    }

    let texts: string[] = [];
    let total = 0;
    try {
      total = pdfInfo(file).pages;
      texts = pageTexts(file);
      checks.push(pagesCheck(texts, total, e.originalPages));
    } catch (err) {
      checks.push({
        name: "pages",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const body = texts.slice(0, e.originalPages).join(" ");
    const missing = e.stampedText.filter((t) => !body.includes(squash(t)));
    checks.push({
      name: "stamped-text",
      ok: e.stampedText.length > 0 && missing.length === 0,
      detail:
        e.stampedText.length === 0
          ? "no text or date values to look for"
          : missing.length === 0
            ? `${e.stampedText.map((t) => JSON.stringify(t)).join(", ")} in the page text`
            : `not in the original pages' text: ${missing.map((t) => JSON.stringify(t)).join(", ")}`,
    });

    checks.push(auditCheck(e.audit));
    checks.push(completedCheck(e.audit.events, e.signedPdf));
    return { ok: checks.every((c) => c.ok), checks };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** One broken copy of a good result, and the checks that must catch it. */
export interface SelfTestCase {
  readonly name: string;
  readonly mustFail: readonly CheckName[];
  readonly mutate: (good: SignedEnvelope) => SignedEnvelope | Promise<SignedEnvelope>;
}

/** The first range a PAdES signature covers, `/ByteRange [0 n …]`; tampering inside it is caught. */
function signedPrefix(bytes: Uint8Array): number {
  const latin1 = Buffer.from(bytes).toString("latin1");
  return Number(/\/ByteRange\s*\[\s*0\s+(\d+)/.exec(latin1)?.[1] ?? bytes.length);
}

export const SELF_TEST_CASES: readonly SelfTestCase[] = [
  {
    name: "tampered byte",
    mustFail: ["seal", "completed-sha256"],
    mutate: (good) => {
      const bytes = new Uint8Array(good.signedPdf);
      const at = Math.floor(signedPrefix(bytes) / 2);
      bytes[at] = (bytes[at] ?? 0) ^ 0x01;
      return { ...good, signedPdf: bytes };
    },
  },
  {
    name: "broken chain",
    mustFail: ["audit-chain"],
    mutate: (good) => {
      const events = [...good.audit.events];
      const i = Math.max(
        0,
        events.findIndex((ev) => ev.action === "signed"),
      );
      const ev = events[i];
      if (ev) events[i] = { ...ev, detail: { ...ev.detail, tampered: true } };
      return { ...good, audit: { ...good.audit, events } };
    },
  },
  {
    name: "missing certificate pages",
    mustFail: ["pages"],
    mutate: async (good) => {
      const pdf = await PDFDocument.load(good.signedPdf);
      for (let i = pdf.getPageCount() - 1; i >= good.originalPages; i--) pdf.removePage(i);
      return { ...good, signedPdf: await pdf.save() };
    },
  },
  {
    name: "missing seal certificate",
    mustFail: ["seal"],
    mutate: (good) => ({ ...good, certificatePem: "" }),
  },
];
