import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@inkly/domain";
import { pyhankoValidate, verifyFile } from "@inkly/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  generateSealKey,
  importSealKey,
  sealPdf,
  stampFields,
  type GeneratedSealKey,
} from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(corpus, name)));
const out = mkdtempSync(join(tmpdir(), "inkly-seal-test-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

let n = 0;
function save(bytes: Uint8Array | string, ext = "pdf"): string {
  const file = join(out, `seal-${String(++n)}.${ext}`);
  writeFileSync(file, bytes);
  return file;
}

let key: GeneratedSealKey;
let certFile: string;
beforeAll(async () => {
  key = await generateSealKey();
  certFile = save(key.certificatePem, "pem");
});

describe("generateSealKey", () => {
  it("makes a self-signed P-256 certificate for the Document seal, valid for 10 years", () => {
    const cert = new X509Certificate(key.certificatePem);
    expect(cert.subject).toBe("CN=Inkly Document Seal");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365.25 * 86_400_000);
    expect(years).toBeCloseTo(10, 1);
    const text = execFileSync("openssl", ["x509", "-noout", "-text", "-in", certFile], {
      encoding: "utf8",
    });
    expect(text).toMatch(/Key Usage: critical\s+Digital Signature, Non Repudiation/);
    expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
  });
});

describe("sealPdf", () => {
  it("adds one PAdES signature that pyHanko reports INTACT and VALID over the whole file", async () => {
    const stamped = await stampFields(fixture("rotated.pdf"), [
      { kind: "text", page: 2, x: 0.1, y: 0.1, w: 0.4, h: 0.05, value: "Signed by Ana" },
    ]);
    const file = save(await sealPdf(stamped, key));
    const verified = verifyFile(file, { expectPages: 3, signed: certFile });
    expect(verified.failures).toEqual([]);
    expect(verified.lines.filter((l) => l.startsWith("signature ok: "))).toHaveLength(1);
    const pretty = execFileSync(
      "pyhanko",
      ["sign", "validate", "--trust", certFile, "--trust-replace", "--pretty-print", file],
      { encoding: "utf8" },
    );
    expect(pretty).toContain("The signature covers the entire file.");
    expect(pretty).toContain("The signature is judged VALID.");
    expect(pretty).toContain("sha256_ecdsa");
  });

  it("fails validation when one byte of the sealed file changes", async () => {
    const sealed = await sealPdf(fixture("10p.pdf"), key);
    expect(pyhankoValidate(save(sealed), certFile).ok).toBe(true);

    const text = Buffer.from(sealed).toString("latin1");
    const at = /\/M \(D:\d/.exec(text);
    if (!at) throw new Error("sealed PDF has no signing date");
    const tampered = new Uint8Array(sealed);
    const digit = at.index + at[0].length - 1;
    tampered[digit] = tampered[digit] === 0x31 ? 0x32 : 0x31;
    const file = save(tampered);
    expect(verifyFile(file).failures, "the change keeps the PDF well-formed").toEqual([]);
    const check = pyhankoValidate(file, certFile);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("INVALID");
  });

  it("is not trusted under another seal certificate", async () => {
    const other = await generateSealKey();
    const file = save(await sealPdf(fixture("tiny.pdf"), key));
    expect(pyhankoValidate(file, save(other.certificatePem, "pem")).ok).toBe(false);
  });

  it("fails verify-pdf --signed on an unsigned PDF", () => {
    const r = verifyFile(join(corpus, "tiny.pdf"), { signed: certFile });
    expect(r.failures).toEqual(["signature invalid: no signatures found"]);
  });
});

describe("importSealKey", () => {
  it("reads the two secrets back into a key that seals", async () => {
    const imported = await importSealKey(key.privateKeyPem, key.certificatePem);
    const file = save(await sealPdf(fixture("forms.pdf"), imported));
    expect(verifyFile(file, { signed: certFile }).failures).toEqual([]);
  });

  it("refuses a key that does not match the certificate, or something that is not PEM", async () => {
    const other = await generateSealKey();
    await expect(importSealKey(other.privateKeyPem, key.certificatePem)).rejects.toMatchObject({
      code: "invalid_input",
      message: "seal key does not match the seal certificate",
    });
    await expect(importSealKey("nope", key.certificatePem)).rejects.toBeInstanceOf(AppError);
    await expect(
      importSealKey(
        key.privateKeyPem.replace(/\n[^\n]+\n-----END/, "\n-----END"),
        key.certificatePem,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});
