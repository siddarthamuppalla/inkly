import { describe, expect, it } from "vitest";

import { fieldLabel } from "../src/lib/forms-api.ts";

describe("fieldLabel", () => {
  it.each([
    ["full_name", "Full name"],
    ["email", "Email"],
    ["date-of_birth", "Date of birth"],
    ["Already Nice", "Already Nice"],
  ])("%s → %s", (name, label) => {
    expect(fieldLabel(name)).toBe(label);
  });
});
