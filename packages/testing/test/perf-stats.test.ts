import { describe, expect, it } from "vitest";

import {
  ABSOLUTE_P95_MS,
  gate,
  percentile,
  REGRESSION_FLOOR_MS,
  summarize,
  type Baseline,
  type OpStats,
} from "../src/perf/stats.ts";

const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

describe("percentile (nearest rank)", () => {
  it("of 10 samples: p50 is the 5th smallest and p95 the largest", () => {
    expect(percentile(ten, 50)).toBe(50);
    expect(percentile(ten, 95)).toBe(100);
  });

  it("does not depend on sample order", () => {
    expect(percentile([100, 10, 90, 20, 80, 30, 70, 40, 60, 50], 50)).toBe(50);
  });

  it("of 20 samples: p95 is the 19th smallest, so one outlier is ignored", () => {
    const twenty = [...Array.from({ length: 19 }, (_, i) => i + 1), 1000];
    expect(percentile(twenty, 95)).toBe(19);
  });

  it("refuses no samples", () => {
    expect(() => percentile([], 50)).toThrow(/no samples/);
  });
});

describe("summarize", () => {
  it("reports p50, p95 and max", () => {
    expect(summarize(ten)).toEqual({ p50: 50, p95: 100, max: 100 });
  });
});

const stats = (p95: number): OpStats => ({ p50: p95, p95, max: p95 });
const baseline = (ops: Record<string, number>): Baseline => ({
  ops: Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, { p95: v }])),
});

describe("gate", () => {
  it("passes when every p95 is under the bound and within 20% of baseline", () => {
    expect(gate({ merge: stats(1100) }, baseline({ merge: 1000 }))).toEqual([]);
  });

  it(`fails a p95 over ${String(ABSOLUTE_P95_MS)} ms even when the baseline is as slow`, () => {
    const failures = gate({ merge: stats(3001) }, baseline({ merge: 3001 }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/merge.*3001.*3000/);
  });

  it("fails a regression of more than 20% and more than the floor", () => {
    const failures = gate({ merge: stats(1300) }, baseline({ merge: 1000 }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/merge.*regressed/);
  });

  it("allows exactly +20%", () => {
    expect(gate({ merge: stats(1200) }, baseline({ merge: 1000 }))).toEqual([]);
  });

  it(`ignores a regression of ${String(REGRESSION_FLOOR_MS)} ms or less, however large in percent`, () => {
    expect(gate({ rotate: stats(10 + REGRESSION_FLOOR_MS) }, baseline({ rotate: 10 }))).toEqual([]);
    expect(
      gate({ rotate: stats(10 + REGRESSION_FLOOR_MS + 1) }, baseline({ rotate: 10 })),
    ).toHaveLength(1);
  });

  it("fails an op with no baseline entry", () => {
    expect(gate({ split: stats(100) }, baseline({}))[0]).toMatch(/split.*no baseline/);
  });

  it("does not fail an improvement", () => {
    expect(gate({ merge: stats(100) }, baseline({ merge: 1000 }))).toEqual([]);
  });
});
