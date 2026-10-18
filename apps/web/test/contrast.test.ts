import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONTRAST_PAIRS,
  contrastRatio,
  FIELD_TINT,
  mix,
  parseThemes,
  RECIPIENT_INKS,
} from "./contrast.ts";

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

  it.each(RECIPIENT_INKS)("%s labels its own tinted field at least 4.5:1", (ink) => {
    const fg = tokens[ink];
    const surface = tokens["field-surface"];
    expect(fg, `--${ink} is not defined`).toBeDefined();
    expect(surface, "--field-surface is not defined").toBeDefined();
    const tinted = mix(fg ?? "", surface ?? "", FIELD_TINT);
    expect(contrastRatio(fg ?? "", tinted)).toBeGreaterThanOrEqual(4.5);
  });

  it("gives every Recipient a different ink", () => {
    const inks = RECIPIENT_INKS.map((ink) => tokens[ink]);
    expect(new Set(inks).size).toBe(RECIPIENT_INKS.length);
  });
});

describe("mix", () => {
  it("blends per channel like color-mix in srgb", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#ff0000", "#0000ff", 0.25)).toBe("#4000bf");
  });
});
