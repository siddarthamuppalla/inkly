import { describe, expect, it } from "vitest";

import {
  AppError,
  canTransition,
  ENVELOPE_STATUSES,
  envelopeLimitError,
  EnvelopeDraft,
  firstTurn,
  sendProblem,
  type SendCheck,
} from "../src/index.ts";

const ANA = { id: "rcp_ana", name: "Ana Ruiz", email: "ana@example.test", role: "signer" } as const;
const BO = { id: "rcp_bo", name: "Bo Li", email: "bo@example.test", role: "signer" } as const;
const CY = { id: "rcp_cy", name: "Cy Park", email: "cy@example.test", role: "cc" } as const;
const sig = (recipientId: string, page = 1) => ({ recipientId, kind: "signature", page }) as const;

const check = (over: Partial<SendCheck> = {}): SendCheck => ({
  recipients: [ANA, BO, CY],
  fields: [sig(ANA.id), sig(BO.id, 2)],
  pages: 2,
  ...over,
});

describe("sendProblem", () => {
  it("passes a draft where every signer has a signature field", () => {
    expect(sendProblem(check())).toBeNull();
  });

  it("names the first problem in the sender's words", () => {
    expect(sendProblem(check({ recipients: [CY], fields: [] }))).toBe("Add at least one signer");
    expect(sendProblem(check({ fields: [sig(BO.id)] }))).toBe("Ana Ruiz has no signature field");
    expect(
      sendProblem(check({ fields: [sig(ANA.id), sig(BO.id), { ...sig(ANA.id), kind: "text" }] })),
    ).toBeNull();
    expect(sendProblem(check({ fields: [sig(ANA.id), sig(BO.id, 3)] }))).toBe(
      "A field is on page 3, but the document has 2 pages",
    );
    expect(sendProblem(check({ fields: [sig(ANA.id), sig(BO.id), sig(CY.id)] }))).toBe(
      "Cy Park gets a copy (CC) and can't have fields",
    );
    expect(sendProblem(check({ recipients: [ANA, { ...BO, email: "ANA@example.test" }] }))).toBe(
      "ana@example.test is on this envelope twice",
    );
  });

  it("does not count an initials field as a signature", () => {
    const fields = [sig(ANA.id), { recipientId: BO.id, kind: "initials", page: 1 } as const];
    expect(sendProblem(check({ fields }))).toBe("Bo Li has no signature field");
  });
});

describe("firstTurn", () => {
  const people = [
    { id: "a", role: "signer", routingOrder: 2 },
    { id: "b", role: "signer", routingOrder: 1 },
    { id: "c", role: "cc", routingOrder: 1 },
    { id: "d", role: "signer", routingOrder: 1 },
  ] as const;

  it("is every signer in parallel and the lowest routing order in sequential; never a CC", () => {
    expect(firstTurn(people, "parallel").map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(firstTurn(people, "sequential").map((r) => r.id)).toEqual(["b", "d"]);
  });
});

describe("status transitions", () => {
  it("lets only a draft be sent and only a sent Envelope be voided", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("sent", "voided")).toBe(true);
    expect(canTransition("draft", "voided")).toBe(false);
    expect(canTransition("completing", "completed")).toBe(true);
    for (const end of ["completed", "declined", "voided", "expired"] as const) {
      expect(ENVELOPE_STATUSES.some((to) => canTransition(end, to))).toBe(false);
    }
  });
});

describe("EnvelopeDraft", () => {
  const base = {
    title: "Lease",
    recipients: [{ id: "rcp_ana", name: "Ana Ruiz", email: " Ana@Example.test ", role: "signer" }],
    fields: [
      { recipientId: "rcp_ana", kind: "signature", page: 1, rect: { x: 0.1, y: 0.8, w: 0.3, h: 0.05 } },
    ],
  };

  it("fills defaults and normalizes emails", () => {
    const draft = EnvelopeDraft.parse(base);
    expect(draft).toMatchObject({ message: "", orderMode: "parallel", expiresInDays: 30 });
    expect(draft.recipients[0]).toMatchObject({ email: "ana@example.test", routingOrder: 1 });
    expect(draft.fields[0]?.required).toBe(true);
  });

  it("refuses a field for a recipient not on the draft, a rect off the page and bad expiry", () => {
    expect(
      EnvelopeDraft.safeParse({ ...base, fields: [{ ...base.fields[0], recipientId: "rcp_x" }] })
        .success,
    ).toBe(false);
    expect(
      EnvelopeDraft.safeParse({
        ...base,
        fields: [{ ...base.fields[0], rect: { x: 0.9, y: 0, w: 0.2, h: 0.1 } }],
      }).success,
    ).toBe(false);
    expect(EnvelopeDraft.safeParse({ ...base, expiresInDays: 91 }).success).toBe(false);
    expect(EnvelopeDraft.safeParse({ ...base, expiresInDays: 0 }).success).toBe(false);
  });
});

describe("envelopeLimitError", () => {
  it("is a 402 limit_exceeded naming the Plan's monthly count", () => {
    const err = envelopeLimitError("free");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "limit_exceeded", status: 402 });
    expect(err.message).toContain("3 envelopes a month");
  });
});
