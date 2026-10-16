import { describe, expect, it } from "vitest";

import { parseRanges, RotateRequest, SplitRequest } from "../src/index.ts";

describe("parseRanges", () => {
  it("reads pages and ranges separated by commas", () => {
    expect(parseRanges("1-3, 5 ,8 - 9")).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 8, to: 9 },
    ]);
  });

  it.each(["", "0", "3-1", "a", "1-", "1,,x"])("refuses %j", (text) => {
    expect(parseRanges(text)).toBeNull();
  });
});

describe("page-op requests", () => {
  it("accepts quarter turns only", () => {
    expect(RotateRequest.safeParse({ pages: [1], degrees: 90 }).success).toBe(true);
    expect(RotateRequest.safeParse({ pages: [1], degrees: 45 }).success).toBe(false);
  });

  it("refuses a reversed split range", () => {
    expect(SplitRequest.safeParse({ ranges: [{ from: 3, to: 1 }] }).success).toBe(false);
  });
});
