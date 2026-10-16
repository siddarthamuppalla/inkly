import { describe, expect, it } from "vitest";

import { formatBytes, formatPages } from "../src/lib/format.ts";

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [1023, "1023 bytes"],
    [6363, "6.2 KB"],
    [25 * 1024 * 1024, "25 MB"],
    [1.5 * 1024 ** 3, "1.5 GB"],
  ])("%d → %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});

describe("formatPages", () => {
  it("uses the singular for one page", () => {
    expect(formatPages(1)).toBe("1 page");
    expect(formatPages(10)).toBe("10 pages");
  });
});
