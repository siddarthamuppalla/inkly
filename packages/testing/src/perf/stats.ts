/** Hard gate: any op whose p95 is over this fails, whatever the baseline says. */
export const ABSOLUTE_P95_MS = 3000;
/** Trend gate: a p95 more than this share above its baseline p95 fails… */
export const REGRESSION_RATIO = 0.2;
/** …unless it is no more than this many ms above it (CI timer and scheduler noise). */
export const REGRESSION_FLOOR_MS = 50;

export interface OpStats {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

/** `perf-baseline.json`: the p95 each op is compared against. */
export interface Baseline {
  readonly generatedOn?: string;
  readonly ops: Readonly<Record<string, { readonly p95: number }>>;
}

/** Nearest-rank percentile: the smallest sample with at least `p`% of samples at or below it. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile of no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export function summarize(samples: readonly number[]): OpStats {
  return {
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: percentile(samples, 100),
  };
}

/** Every reason `results` fail the perf gate against `baseline`; empty means pass. */
export function gate(results: Readonly<Record<string, OpStats>>, baseline: Baseline): string[] {
  const failures: string[] = [];
  for (const [op, { p95 }] of Object.entries(results)) {
    if (p95 > ABSOLUTE_P95_MS) {
      failures.push(`${op}: p95 ${ms(p95)} is over the ${ms(ABSOLUTE_P95_MS)} bound`);
    }
    const base = baseline.ops[op];
    if (base === undefined) {
      failures.push(`${op}: no baseline entry (run with --update-baseline)`);
      continue;
    }
    const over = p95 - base.p95;
    if (p95 > base.p95 * (1 + REGRESSION_RATIO) && over > REGRESSION_FLOOR_MS) {
      const pct = Math.round((over / base.p95) * 100);
      failures.push(
        `${op}: p95 regressed ${String(pct)}% (${ms(base.p95)} → ${ms(p95)}); limit is +${String(REGRESSION_RATIO * 100)}% and more than ${ms(REGRESSION_FLOOR_MS)}`,
      );
    }
  }
  return failures;
}

function ms(n: number): string {
  return `${String(Math.round(n))} ms`;
}
