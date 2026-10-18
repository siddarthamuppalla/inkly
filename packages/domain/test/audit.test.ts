import { describe, expect, it } from "vitest";

import {
  auditHash,
  canonicalJson,
  chained,
  GENESIS,
  sha256Hex,
  verifyChain,
  type AuditEvent,
  type AuditEventBody,
} from "../src/index.ts";

const FIRST: AuditEventBody = {
  tenantId: "ten_a",
  subjectType: "envelope",
  subjectId: "env_1",
  seq: 1,
  actor: "usr_1",
  action: "created",
  detail: { documentId: "doc_1", version: 1, title: "Lease" },
  ip: "203.0.113.7",
  userAgent: "Browser/1.0",
  at: 1_760_000_000_000,
};

function chain(): AuditEvent[] {
  const bodies: AuditEventBody[] = [
    FIRST,
    { ...FIRST, seq: 2, action: "sent", detail: { recipients: 2 }, at: FIRST.at + 1000 },
    {
      ...FIRST,
      seq: 3,
      action: "notified",
      detail: { recipientId: "rcp_1", email: "ana@example.test" },
      at: FIRST.at + 2000,
    },
  ];
  const events: AuditEvent[] = [];
  for (const body of bodies) events.push(chained(events.at(-1)?.hash ?? GENESIS, body));
  return events;
}

describe("canonical JSON", () => {
  it("sorts keys at every level and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: "é" }], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,{"y":"é","z":null}]},"b":1}',
    );
  });
});

describe("sha256Hex", () => {
  // Expected values from `sha256sum` / node:crypto.
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["é漢字😀", "d8474b7aad1cb58d06cacd69d232ed694056f27641d7773b1e4cd9a3446a95fd"],
    ["x".repeat(55), "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072"],
    ["x".repeat(56), "04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e"],
    ["y".repeat(1000), "7e33ae3f1e88ddf3291109cc366b12dcd8bf8fe77bec53009f200a76e4649c07"],
  ])("matches SHA-256 of %j", (text, hex) => {
    expect(sha256Hex(text)).toBe(hex);
  });
});

describe("auditHash", () => {
  it("is hex sha256 of prev + newline + canonical JSON of the event", () => {
    expect(auditHash(GENESIS, FIRST)).toBe(sha256Hex(`${GENESIS}\n${canonicalJson({ ...FIRST })}`));
  });

  // Recomputed outside this code: sha256 of "0"×64 + "\n" + the sorted-key JSON of FIRST.
  it("is pinned for one event", () => {
    expect(auditHash(GENESIS, FIRST)).toBe(
      "6e9e4af3b04235a4e7e418b60036ca762d8e07c0e71f4ee6f5b09113a3de4a89",
    );
  });

  it("ignores prevHash and hash fields carried on the event itself", () => {
    const [first] = chain();
    expect(first && auditHash(GENESIS, first)).toBe(first?.hash);
  });
});

describe("verifyChain", () => {
  it("accepts an intact chain and reports its head", () => {
    const events = chain();
    expect(verifyChain(events)).toEqual({ valid: true, head: events[2]?.hash });
    expect(verifyChain([])).toEqual({ valid: true, head: GENESIS });
  });

  it.each([
    ["actor", { actor: "usr_2" }],
    ["action", { action: "voided" }],
    ["detail", { detail: { recipients: 3 } }],
    ["ip", { ip: null }],
    ["userAgent", { userAgent: "Other/2.0" }],
    ["at", { at: 1 }],
    ["tenantId", { tenantId: "ten_b" }],
    ["subjectId", { subjectId: "env_2" }],
  ] as const)("reports the first broken seq when an earlier event's %s changes", (_, change) => {
    const events = chain();
    const tampered = events.map((e) => (e.seq === 2 ? { ...e, ...change } : e));
    expect(verifyChain(tampered)).toMatchObject({ valid: false, brokenAt: 2 });
  });

  it("breaks at the next event when a hash is recomputed in place", () => {
    const events = chain();
    const second = events[1];
    if (!second) throw new Error("chain too short");
    const forged = { ...second, detail: { recipients: 9 } };
    const rehashed = { ...forged, hash: auditHash(forged.prevHash, forged) };
    expect(verifyChain([events[0], rehashed, events[2]] as AuditEvent[])).toMatchObject({
      valid: false,
      brokenAt: 3,
    });
  });

  it("refuses a gap or reordering in seq", () => {
    const events = chain();
    expect(verifyChain([events[0], events[2]] as AuditEvent[])).toMatchObject({
      valid: false,
      brokenAt: 3,
    });
  });
});
