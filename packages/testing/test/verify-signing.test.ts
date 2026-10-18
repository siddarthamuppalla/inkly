import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chained, GENESIS, verifyChain, type AuditEvent, type AuditEventBody } from "@inkly/domain";
import { appendCertificate, generateSealKey, sealPdf, stampFields } from "@inkly/pdf";
import { beforeAll, describe, expect, it } from "vitest";

import {
  checkSignedEnvelope,
  SELF_TEST_CASES,
  type CheckName,
  type SignedEnvelope,
} from "../src/signing/check.ts";

// A sealed Envelope built in process the way finalize builds one (stamp, certificate, seal,
// then the `completed` event over the sealed bytes), so the checks run without a Worker.

const original = new Uint8Array(
  readFileSync(join(import.meta.dirname, "../../../fixtures/pdfs/10p.pdf")),
);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const TEXT = "Apt 4B, verify-signing";
const DATE = "2026-10-18";

function trail(
  bodies: readonly Omit<AuditEventBody, "seq" | "tenantId" | "subjectType" | "subjectId">[],
) {
  const events: AuditEvent[] = [];
  for (const [i, b] of bodies.entries()) {
    events.push(
      chained(events.at(-1)?.hash ?? GENESIS, {
        tenantId: "tnt_test",
        subjectType: "envelope",
        subjectId: "env_test",
        seq: i + 1,
        ...b,
      }),
    );
  }
  return events;
}

let good: SignedEnvelope;
beforeAll(async () => {
  const key = await generateSealKey("verify-signing test seal");
  const at = Date.UTC(2026, 9, 18);
  const before = trail([
    { actor: "usr_a", action: "created", detail: {}, ip: null, userAgent: null, at },
    { actor: "usr_a", action: "sent", detail: {}, ip: null, userAgent: null, at },
    {
      actor: "rcp_ana",
      action: "signed",
      detail: { fields: [{ id: "fld_t", kind: "text", value: TEXT }] },
      ip: "127.0.0.1",
      userAgent: "test",
      at,
    },
  ]);
  const stamped = await stampFields(original, [
    { kind: "text", page: 1, x: 0.1, y: 0.2, w: 0.5, h: 0.05, value: TEXT },
    { kind: "date", page: 2, x: 0.1, y: 0.3, w: 0.3, h: 0.05, value: DATE },
  ]);
  const certified = await appendCertificate(stamped, {
    envelopeId: "env_test",
    title: "verify-signing test",
    documentSha256: sha256(original),
    sentAt: at,
    completedAt: at,
    sender: { name: "Sam Sender", email: "sam@verify.inkly.test" },
    recipients: [
      {
        name: "Ana Ruiz",
        email: "ana@verify.inkly.test",
        role: "signer",
        ip: "127.0.0.1",
        userAgent: "test",
        viewedAt: at,
        signedAt: at,
        signature: null,
      },
    ],
    events: before.map((e) => ({
      seq: e.seq,
      at: e.at,
      actor: e.actor,
      action: e.action,
      hash: e.hash,
    })),
  });
  const sealed = await sealPdf(certified, key);
  const last = before.at(-1);
  const events = [
    ...before,
    chained(last?.hash ?? GENESIS, {
      tenantId: "tnt_test",
      subjectType: "envelope",
      subjectId: "env_test",
      seq: before.length + 1,
      actor: "system",
      action: "completed",
      detail: { version: 2, sha256: sha256(sealed) },
      ip: null,
      userAgent: null,
      at,
    }),
  ];
  good = {
    signedPdf: sealed,
    originalPages: 10,
    certificatePem: key.certificatePem,
    stampedText: [TEXT, DATE],
    audit: { events, chain: verifyChain(events) },
  };
});

const failed = (r: { checks: readonly { name: CheckName; ok: boolean }[] }) =>
  r.checks.filter((c) => !c.ok).map((c) => c.name);

describe("checkSignedEnvelope", () => {
  it("passes a sealed Envelope and runs every check", () => {
    const r = checkSignedEnvelope(good);
    expect(failed(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      "qpdf",
      "seal",
      "pages",
      "stamped-text",
      "audit-chain",
      "completed-sha256",
    ]);
    expect(r.checks.find((c) => c.name === "pages")?.detail).toMatch(
      /^10 original \+ \d+ certificate = \d+$/,
    );
  });

  it("fails when a stamped value is not in the original pages' text", () => {
    const r = checkSignedEnvelope({ ...good, stampedText: [TEXT, "Not stamped anywhere"] });
    expect(failed(r)).toEqual(["stamped-text"]);
  });

  it("fails when the original page count does not add up", () => {
    const r = checkSignedEnvelope({ ...good, originalPages: 9 });
    expect(failed(r)).toContain("pages");
  });

  it("fails when GET …/audit reports a head the events do not hash to", () => {
    const r = checkSignedEnvelope({
      ...good,
      audit: { ...good.audit, chain: { valid: true, head: "f".repeat(64) } },
    });
    expect(failed(r)).toEqual(["audit-chain"]);
  });
});

describe("self-test mutations", () => {
  it("names a tampered byte, a broken chain and a missing certificate", () => {
    expect(SELF_TEST_CASES.map((c) => c.name)).toEqual([
      "tampered byte",
      "broken chain",
      "missing certificate pages",
      "missing seal certificate",
    ]);
  });

  for (const c of SELF_TEST_CASES) {
    it(`${c.name} fails ${c.mustFail.join(" and ")}`, async () => {
      const r = checkSignedEnvelope(await c.mutate(good));
      expect(r.ok).toBe(false);
      for (const name of c.mustFail) expect(failed(r)).toContain(name);
    });
  }
});
