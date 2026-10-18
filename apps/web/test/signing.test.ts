import type { SignerField } from "@inkly/domain";
import { describe, expect, it } from "vitest";

import {
  fieldName,
  initialsOf,
  inPageOrder,
  missingFields,
  nextField,
  submittedValues,
} from "../src/lib/signing.ts";

const field = (
  id: string,
  kind: SignerField["kind"],
  page: number,
  y: number,
  x = 0.1,
  required = true,
): SignerField => ({ id, kind, page, rect: { x, y, w: 0.2, h: 0.05 }, required });

const sig2 = field("fld_sig2", "signature", 2, 0.1);
const date1 = field("fld_date", "date", 1, 0.9);
const sig1 = field("fld_sig1", "signature", 1, 0.5);
const text1 = field("fld_text", "text", 1, 0.5, 0.05, false);
const box1 = field("fld_box", "checkbox", 1, 0.2);

describe("inPageOrder", () => {
  it("sorts by page, then top to bottom, then left to right", () => {
    expect(inPageOrder([sig2, date1, sig1, text1, box1]).map((f) => f.id)).toEqual([
      "fld_box",
      "fld_text",
      "fld_sig1",
      "fld_date",
      "fld_sig2",
    ]);
  });
});

describe("nextField", () => {
  const ordered = inPageOrder([sig2, date1, sig1, box1]);
  it("walks unfilled fields in page order, skipping dates and filled ones, and wraps", () => {
    expect(nextField(ordered, {}, null)?.id).toBe("fld_box");
    expect(nextField(ordered, { fld_box: "true" }, null)?.id).toBe("fld_sig1");
    expect(nextField(ordered, {}, "fld_sig1")?.id).toBe("fld_sig2");
    expect(nextField(ordered, {}, "fld_sig2")?.id).toBe("fld_box");
    expect(nextField(ordered, { fld_box: "true", fld_sig1: "x", fld_sig2: "x" }, null)).toBeNull();
  });
});

describe("missingFields", () => {
  it("lists required fields without a value; dates and optional fields never block", () => {
    const fields = [sig1, date1, text1, box1];
    expect(missingFields(fields, {}).map((f) => f.id)).toEqual(["fld_sig1", "fld_box"]);
    expect(missingFields(fields, { fld_sig1: "x", fld_box: "false" }).map((f) => f.id)).toEqual([
      "fld_box",
    ]);
    expect(missingFields(fields, { fld_sig1: "x", fld_box: "true" })).toEqual([]);
  });
});

describe("fieldName", () => {
  it("counts fields of the same kind and says required", () => {
    const ordered = inPageOrder([sig2, sig1, text1]);
    expect(fieldName(sig1, ordered)).toBe("Signature 1 of 2, page 1 (required)");
    expect(fieldName(text1, ordered)).toBe("Text, page 1");
  });
});

describe("initialsOf", () => {
  it("takes the first letter of each name", () => {
    expect(initialsOf(" ana maría  Ruiz ")).toBe("AMR");
  });
});

describe("submittedValues", () => {
  it("leaves out dates and blanks", () => {
    expect(
      submittedValues([sig1, date1, text1], { fld_sig1: "png", fld_date: "x", fld_text: "" }),
    ).toEqual({ fld_sig1: "png" });
  });
});
