import { describe, expect, it } from "vitest";

import {
  draftProblem,
  inkVar,
  moveRecipient,
  newId,
  removeRecipient,
  toBody,
  type Draft,
} from "../src/lib/envelope-draft.ts";

const ana = { id: "rcp_ana", name: "Ana Ruiz", email: "ana@example.com", role: "signer" } as const;
const ben = { id: "rcp_ben", name: "Ben Ode", email: "ben@example.com", role: "signer" } as const;
const cat = { id: "rcp_cat", name: "Cat Lin", email: "cat@example.com", role: "cc" } as const;
const sig = (recipientId: string, page = 1) => ({
  id: newId("fld"),
  recipientId,
  kind: "signature" as const,
  page,
  rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
  required: true,
});

const draft: Draft = {
  title: "Lease",
  message: "",
  orderMode: "sequential",
  expiresInDays: 30,
  recipients: [ana, ben, cat],
  fields: [sig("rcp_ana"), sig("rcp_ben")],
};

describe("draftProblem", () => {
  it("is null for a draft send would accept", () => {
    expect(draftProblem(draft, 10)).toBeNull();
  });

  it("names the signer who has no signature field", () => {
    expect(draftProblem({ ...draft, fields: [sig("rcp_ana")] }, 10)).toBe(
      "Ben Ode has no signature field",
    );
  });

  it("names a field off the end of the document", () => {
    expect(draftProblem({ ...draft, fields: [...draft.fields, sig("rcp_ana", 11)] }, 10)).toBe(
      "A field is on page 11, but the document has 10 pages",
    );
  });

  it("names a CC with fields", () => {
    expect(draftProblem({ ...draft, fields: [...draft.fields, sig("rcp_cat")] }, 10)).toBe(
      "Cat Lin gets a copy (CC) and can't have fields",
    );
  });

  it("names an incomplete recipient before anything send checks", () => {
    const blank = { ...ben, email: "ben@" };
    expect(draftProblem({ ...draft, recipients: [ana, blank, cat] }, 10)).toBe(
      "Enter a valid email address",
    );
  });

  it("asks for a signer when there is none", () => {
    expect(draftProblem({ ...draft, recipients: [cat], fields: [] }, 10)).toBe(
      "Add at least one signer",
    );
  });
});

describe("routing order", () => {
  it("is each recipient's place in the list", () => {
    expect(toBody(draft).recipients.map((r) => [r.id, r.routingOrder])).toEqual([
      ["rcp_ana", 1],
      ["rcp_ben", 2],
      ["rcp_cat", 3],
    ]);
  });

  it("moves a recipient up or down and ignores a move off either end", () => {
    const ids = (d: Draft) => d.recipients.map((r) => r.id);
    expect(ids(moveRecipient(draft, "rcp_ben", -1))).toEqual(["rcp_ben", "rcp_ana", "rcp_cat"]);
    expect(ids(moveRecipient(draft, "rcp_ben", 1))).toEqual(["rcp_ana", "rcp_cat", "rcp_ben"]);
    expect(moveRecipient(draft, "rcp_ana", -1)).toBe(draft);
    expect(moveRecipient(draft, "rcp_cat", 1)).toBe(draft);
  });
});

describe("removeRecipient", () => {
  it("drops the recipient's fields too, so the draft still saves", () => {
    const left = removeRecipient(draft, "rcp_ben");
    expect(left.recipients.map((r) => r.id)).toEqual(["rcp_ana", "rcp_cat"]);
    expect(left.fields.every((f) => f.recipientId === "rcp_ana")).toBe(true);
  });
});

describe("ids and inks", () => {
  it("mints ids the API keeps", () => {
    expect(newId("rcp")).toMatch(/^rcp_[A-Za-z0-9]{1,60}$/);
    expect(newId("fld")).toMatch(/^fld_[A-Za-z0-9]{1,60}$/);
  });

  it("cycles through the six recipient inks", () => {
    expect(inkVar(0)).toBe("var(--recipient-1)");
    expect(inkVar(5)).toBe("var(--recipient-6)");
    expect(inkVar(6)).toBe("var(--recipient-1)");
  });
});
