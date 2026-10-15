import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { startEngine, type LocalEngine } from "../src/perf/engine.ts";
import { benchmark, perfOps, RUNS, WARMUPS } from "../src/perf/ops.ts";
import { ABSOLUTE_P95_MS, gate, type Baseline, type OpStats } from "../src/perf/stats.ts";

const USAGE = `usage:
  verify-perf [--update-baseline]
  verify-perf --self-test
  verify-perf --url URL   (not yet available)`;

const repoRoot = resolve(import.meta.dirname, "../../..");
const baselinePath = resolve(repoRoot, ".claude/skills/verify-perf/perf-baseline.json");

type Results = Record<string, OpStats>;

function print(results: Results, baseline: Baseline | undefined): void {
  const w = Math.max(...Object.keys(results).map((k) => k.length), 2);
  const col = (s: string) => s.padStart(9);
  console.log(
    `${"op".padEnd(w)}${col("p50 ms")}${col("p95 ms")}${col("max ms")}${col("base p95")}`,
  );
  for (const [op, s] of Object.entries(results)) {
    const base = baseline?.ops[op]?.p95;
    console.log(
      `${op.padEnd(w)}${col(fmt(s.p50))}${col(fmt(s.p95))}${col(fmt(s.max))}${col(base === undefined ? "-" : fmt(base))}`,
    );
  }
}

function fmt(n: number): string {
  return n.toFixed(1);
}

function readBaseline(): Baseline | undefined {
  if (!existsSync(baselinePath)) return undefined;
  return JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;
}

/**
 * Benchmarks every op. With `confirm`, each op that fails the gate against it is measured
 * once more and keeps the run with the lower p95, so one noisy run cannot fail the gate.
 */
async function run(confirm?: Baseline): Promise<Results> {
  let engine: LocalEngine | undefined;
  try {
    engine = await startEngine(repoRoot);
    const ops = perfOps(repoRoot, engine.url);
    console.log(`${String(RUNS)} runs per op after ${String(WARMUPS)} warm-up…`);
    const results = await benchmark(ops);
    if (confirm === undefined) return results;
    const failing = ops.filter((op) => {
      const s = results[op.name];
      return s !== undefined && gate({ [op.name]: s }, confirm).length > 0;
    });
    if (failing.length === 0) return results;
    console.log(`re-measuring to confirm: ${failing.map((op) => op.name).join(", ")}`);
    const again = await benchmark(failing);
    for (const [name, s] of Object.entries(again)) {
      const first = results[name];
      if (first === undefined || s.p95 < first.p95) results[name] = s;
    }
    return results;
  } finally {
    engine?.stop();
  }
}

/** Scales every p95 by `factor` (rounded to 0.1 ms), as if measured on another machine. */
function scaled(results: Results, factor: number): Baseline {
  return {
    ops: Object.fromEntries(
      Object.entries(results).map(([op, s]) => [op, { p95: Math.round(s.p95 * factor * 10) / 10 }]),
    ),
  };
}

async function selfTest(): Promise<number> {
  const results = await run();
  print(results, undefined);
  const problems: string[] = [];

  const self = gate(results, scaled(results, 1));
  if (self.length > 0) problems.push(`results failed against themselves: ${self.join("; ")}`);

  const tenTimesFaster = gate(results, scaled(results, 0.1));
  console.log(`against a baseline 10x faster: ${String(tenTimesFaster.length)} failure(s)`);
  for (const f of tenTimesFaster) console.log(`  caught: ${f}`);
  if (!tenTimesFaster.some((f) => f.includes("regressed"))) {
    problems.push("a baseline 10x faster did not trigger the regression rule");
  }

  const slow = { ...results, "fabricated slow op": { p50: 1, p95: ABSOLUTE_P95_MS + 1, max: 1 } };
  const bound = gate(slow, scaled(slow, 1));
  console.log(`with a fabricated p95 of ${String(ABSOLUTE_P95_MS + 1)} ms: ${bound.join("; ")}`);
  if (!bound.some((f) => f.includes("bound"))) {
    problems.push(`a p95 over ${String(ABSOLUTE_P95_MS)} ms did not trigger the bound`);
  }

  for (const p of problems) console.log(`FAIL ${p}`);
  console.log(
    problems.length === 0
      ? "verify-perf self-test: PASS (the gate fires)"
      : "verify-perf self-test: FAIL",
  );
  return problems.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      "update-baseline": { type: "boolean" },
      "self-test": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (values.url !== undefined) {
    console.error("verify-perf --url: not yet: needs page-op API (T1.3b)");
    return 2;
  }
  if (values["self-test"] === true) return selfTest();

  if (values["update-baseline"] === true) {
    // Two passes, keeping each op's higher p95: a lucky quiet pass must not become the bar.
    const first = await run();
    const second = await run();
    const results: Results = {};
    for (const [op, s] of Object.entries(first)) {
      const t = second[op];
      results[op] = t !== undefined && t.p95 > s.p95 ? t : s;
    }
    const machine = `${platform()}, ${cpus()[0]?.model ?? "unknown CPU"} x${String(cpus().length)}`;
    const baseline: Baseline = {
      generatedOn: `${new Date().toISOString()} on ${machine}`,
      ...scaled(results, 1),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    print(results, baseline);
    console.log(`verify-perf: baseline written to ${baselinePath}`);
    return 0;
  }

  const baseline = readBaseline();
  if (baseline === undefined) {
    console.log(`FAIL no baseline at ${baselinePath} (run with --update-baseline)`);
    return 1;
  }
  const results = await run(baseline);
  print(results, baseline);
  const failures = gate(results, baseline);
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(failures.length === 0 ? "verify-perf: PASS" : "verify-perf: FAIL");
  return failures.length === 0 ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`verify-perf: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
