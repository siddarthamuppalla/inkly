import { describe, expect, it } from "vitest";

import {
  everySignerSigned,
  fieldFilled,
  fieldValueProblem,
  nextTurn,
  SignerSign,
  signingDate,
} from "../src/index.ts";

// base64 of the 8-byte PNG signature plus "A" (9 bytes), then "xxx" per 4 characters.
const png = (triples = 1) => `data:image/png;base64,iVBORw0KGgpB${"eHh4".repeat(triples)}`;

describe("fieldValueProblem", () => {
  it("takes a PNG data URL for signature and initials, up to 200 KB decoded", () => {
    expect(fieldValueProblem("signature", png())).toBeNull();
    expect(fieldValueProblem("initials", png())).toBeNull();
    expect(fieldValueProblem("signature", png(68_263))).toBeNull(); // 204,798 bytes
    expect(fieldValueProblem("signature", png(68_264))).toBe("The signature image is over 200 KB");
    expect(fieldValueProblem("signature", "data:image/jpeg;base64,/9j/")).toBe(
      "The signature must be a PNG image",
    );
    expect(fieldValueProblem("signature", "data:image/png;base64,R0lGODlh")).toBe(
      "The signature must be a PNG image",
    );
    expect(fieldValueProblem("initials", "data:image/png;base64,***")).toBe(
      "The initials must be a PNG image",
    );
  });

  it('takes "true" or "false" for a checkbox and up to 500 characters of text', () => {
    expect(fieldValueProblem("checkbox", "true")).toBeNull();
    expect(fieldValueProblem("checkbox", "false")).toBeNull();
    expect(fieldValueProblem("checkbox", "yes")).toBe('A checkbox is "true" or "false"');
    expect(fieldValueProblem("text", "x".repeat(500))).toBeNull();
    expect(fieldValueProblem("text", "x".repeat(501))).toBe(
      "Text fields hold up to 500 characters",
    );
  });
});

describe("fieldFilled", () => {
  it("counts dates as filled and an unticked box or blank text as empty", () => {
    expect(fieldFilled("date", undefined)).toBe(true);
    expect(fieldFilled("checkbox", "false")).toBe(false);
    expect(fieldFilled("checkbox", "true")).toBe(true);
    expect(fieldFilled("text", "  ")).toBe(false);
    expect(fieldFilled("signature", null)).toBe(false);
    expect(fieldFilled("signature", png())).toBe(true);
  });
});

describe("signingDate", () => {
  it("is the UTC calendar date", () => {
    expect(signingDate(Date.UTC(2026, 9, 18, 23, 59))).toBe("2026-10-18");
  });
});

describe("SignerSign", () => {
  it("needs consent: true and field ids as keys", () => {
    expect(SignerSign.safeParse({ values: { fld_a: "x" }, consent: true }).success).toBe(true);
    expect(SignerSign.safeParse({ values: { fld_a: "x" }, consent: false }).success).toBe(false);
    expect(SignerSign.safeParse({ values: { other: "x" }, consent: true }).success).toBe(false);
  });
});

const signer = (routingOrder: number, status: "waiting" | "sent" | "viewed" | "signed") =>
  ({ role: "signer", routingOrder, status }) as const;
const cc = { role: "cc", routingOrder: 9, status: "waiting" } as const;

describe("nextTurn", () => {
  it("notifies the next routing order once the current one has signed", () => {
    const one = signer(1, "signed");
    const two = signer(2, "waiting");
    const twoB = signer(2, "waiting");
    expect(nextTurn([one, two, twoB, cc], "sequential")).toEqual([two, twoB]);
  });

  it("notifies nobody while the current order is still signing or already notified", () => {
    const signing = [signer(1, "signed"), signer(1, "viewed"), signer(2, "waiting")];
    expect(nextTurn(signing, "sequential")).toEqual([]);
    expect(nextTurn([signer(1, "signed"), signer(2, "sent")], "sequential")).toEqual([]);
    expect(nextTurn([signer(1, "signed"), signer(2, "waiting")], "parallel")).toEqual([]);
    expect(nextTurn([signer(1, "signed"), cc], "sequential")).toEqual([]);
  });
});

describe("everySignerSigned", () => {
  it("ignores CCs", () => {
    expect(everySignerSigned([signer(1, "signed"), cc])).toBe(true);
    expect(everySignerSigned([signer(1, "signed"), signer(2, "sent")])).toBe(false);
  });
});
