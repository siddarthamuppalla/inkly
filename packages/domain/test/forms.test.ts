import { describe, expect, it } from "vitest";

import { FormFill } from "../src/index.ts";

describe("FormFill", () => {
  it("defaults flatten to false and accepts every value kind", () => {
    const values = { name: "Ada", agree: true, size: null, toppings: ["Basil"] };
    expect(FormFill.parse({ values })).toEqual({ values, flatten: false });
  });

  it("refuses values that are not a name-to-value map", () => {
    for (const bad of [{}, { values: "x" }, { values: { n: 1 } }, { values: {}, flatten: "yes" }]) {
      expect(FormFill.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
