import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@inkly/domain";
import { verifyFile } from "@inkly/testing";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import {
  appendCertificate,
  type CertificateEvent,
  type CompletionCertificate,
} from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(corpus, name)));
const out = mkdtempSync(join(tmpdir(), "inkly-certificate-test-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGOQcj8k5X4IAAasAkez8fvzAAAAAElFTkSuQmCC";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const T0 = Date.UTC(2026, 9, 18, 9, 30, 0);
const ACTIONS = ["created", "sent", "notified", "viewed", "verified", "signed", "completed"];

function events(count: number): CertificateEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    at: T0 + i * 60_000,
    actor: i % 2 === 0 ? "Sid Muppalla <sid@example.com>" : "Ana Ruiz <ana@example.com>",
    action: ACTIONS[i % ACTIONS.length] ?? "viewed",
    hash: sha256(`event ${String(i)}`),
  }));
}

function certificate(eventCount: number): CompletionCertificate {
  return {
    envelopeId: "env_7f3c2a9e",
    title: "Mutual NDA — Acme Corp & Inkly Ltd",
    documentSha256: sha256("original document"),
    sentAt: T0,
    completedAt: T0 + 3_600_000,
    sender: { name: "Sid Muppalla", email: "sid@example.com" },
    recipients: [
      {
        name: "Ana Ruiz",
        email: "ana@example.com",
        role: "signer",
        ip: "203.0.113.7",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
        viewedAt: T0 + 600_000,
        signedAt: T0 + 900_000,
        signature: SIGNATURE,
      },
      {
        name: "Bo Chen",
        email: "bo@example.com",
        role: "cc",
        ip: null,
        userAgent: null,
        viewedAt: null,
        signedAt: null,
        signature: null,
      },
    ],
    events: events(eventCount),
  };
}

let n = 0;
function save(bytes: Uint8Array): string {
  const file = join(out, `certified-${String(++n)}.pdf`);
  writeFileSync(file, bytes);
  return file;
}

const text = (file: string, first: number) =>
  execFileSync("pdftotext", ["-f", String(first), file, "-"], { encoding: "utf8" });

describe("appendCertificate", () => {
  it("appends a page listing the Envelope, Recipients and every audit event", async () => {
    const cert = certificate(4);
    const bytes = await appendCertificate(fixture("10p.pdf"), cert);
    const file = save(bytes);
    const verified = verifyFile(file, { expectPages: 11 });
    expect(verified.failures).toEqual([]);

    const page = text(file, 11).replace(/\s+/g, " ");
    for (const expected of [
      "Certificate of completion",
      "Mutual NDA — Acme Corp & Inkly Ltd",
      "env_7f3c2a9e",
      cert.documentSha256,
      "Sid Muppalla <sid@example.com>",
      "2026-10-18 09:30:00 UTC",
      "2026-10-18 10:30:00 UTC",
      "Ana Ruiz",
      "ana@example.com",
      "Email code",
      "203.0.113.7",
      "Chrome/129.0.0.0 Safari/537.36",
      "2026-10-18 09:40:00 UTC",
      "2026-10-18 09:45:00 UTC",
      "Bo Chen",
      "CC",
      "Page 1 of 1",
    ]) {
      expect(page).toContain(expected);
    }
    for (const e of cert.events) {
      expect(page).toContain(`sha256 ${e.hash}`);
      expect(page).toContain(e.action);
    }
  });

  it("draws the signer's signature image on the certificate", async () => {
    const bytes = await appendCertificate(fixture("tiny.pdf"), certificate(1));
    const doc = await PDFDocument.load(bytes);
    const xobjects = doc.getPage(1).node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    expect(xobjects?.keys().length).toBe(1);
  });

  it("wraps a long audit trail onto more pages, each numbered", async () => {
    const cert = certificate(120);
    const file = save(await appendCertificate(fixture("tiny.pdf"), cert));
    const pages = verifyFile(file).info?.pages ?? 0;
    expect(pages).toBeGreaterThan(4);
    const appended = pages - 1;
    const all = text(file, 2);
    expect(all).toContain(`Page ${String(appended)} of ${String(appended)}`);
    expect(all).toContain("Certificate of completion (continued)");
    for (const e of cert.events) expect(all).toContain(e.hash);
  });

  it.each([
    ["tiny.pdf", 612, 792],
    ["10p.pdf", 595.28, 841.89],
  ])("matches %s's paper size", async (name, width, height) => {
    const bytes = await appendCertificate(fixture(name), certificate(1));
    const doc = await PDFDocument.load(bytes);
    const size = doc.getPage(doc.getPageCount() - 1).getSize();
    expect(size.width).toBeCloseTo(width, 1);
    expect(size.height).toBeCloseTo(height, 1);
  });

  it("refuses a signature that is not a PNG", async () => {
    const cert = certificate(1);
    const [first, ...rest] = cert.recipients;
    if (!first) throw new Error("no recipient");
    await expect(
      appendCertificate(fixture("tiny.pdf"), {
        ...cert,
        recipients: [{ ...first, signature: "data:image/png;base64,iVBORw0KGgoAAAAAAAA" }, ...rest],
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
