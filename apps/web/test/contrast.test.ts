import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CONTRAST_PAIRS, contrastRatio, parseThemes } from "./contrast.ts";

const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const themes = parseThemes(css);

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
  });
});

describe.each(Object.entries(themes))("%s theme", (_name, tokens) => {
  it.each(CONTRAST_PAIRS)("$fg on $bg is at least $min:1", ({ fg, bg, min }) => {
    const f = tokens[fg];
    const b = tokens[bg];
    expect(f, `--${fg} is not defined`).toBeDefined();
    expect(b, `--${bg} is not defined`).toBeDefined();
    expect(contrastRatio(f ?? "", b ?? "")).toBeGreaterThanOrEqual(min);
  });
});
