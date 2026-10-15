import { readFileSync } from "node:fs";
import { join } from "node:path";

import { merge, pageNumber, reorder, rotate, split, type PageRange } from "@inkly/pdf";

import { summarize, type OpStats } from "./stats.ts";

export const RUNS = 10;
export const WARMUPS = 1;

/** One benchmarked op. `run` throws if the op did not do the work, so a no-op can't look fast. */
export interface PerfOp {
  readonly name: string;
  run(): Promise<void>;
}

const pages = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => pageNumber(from + i));

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`benchmark op did no work: ${what}`);
}

/** The page ops (in-process `@inkly/pdf`) and compress (pdf-engine at `engineUrl`). */
export function perfOps(repoRoot: string, engineUrl: string): PerfOp[] {
  const fixture = (name: string) =>
    new Uint8Array(readFileSync(join(repoRoot, "fixtures/pdfs", name)));
  const p50 = fixture("50p.pdf");
  const p10 = fixture("10p.pdf");
  const huge = fixture("huge-image.pdf");
  const ranges: PageRange[] = [0, 1, 2, 3, 4].map((i) => ({
    from: pageNumber(i * 10 + 1),
    to: pageNumber(i * 10 + 10),
  }));

  const compress = (name: string, input: Uint8Array): PerfOp => ({
    name,
    async run() {
      const res = await fetch(`${engineUrl}/compress?level=ebook`, {
        method: "POST",
        body: input,
      });
      const body = await res.arrayBuffer();
      check(res.status === 200 && body.byteLength > 0, `${name} answered ${String(res.status)}`);
    },
  });

  return [
    {
      name: "merge 50p+10p",
      async run() {
        check((await merge([p50, p10])).length > 0, "merge");
      },
    },
    {
      name: "split 50p into 5",
      async run() {
        check((await split(p50, ranges)).length === 5, "split");
      },
    },
    {
      name: "rotate 50p all pages",
      async run() {
        check((await rotate(p50, pages(1, 50), 90)).length > 0, "rotate");
      },
    },
    {
      name: "reorder 50p reversed",
      async run() {
        check((await reorder(p50, pages(1, 50).reverse())).length > 0, "reorder");
      },
    },
    compress("compress 50p ebook", p50),
    compress("compress huge-image ebook", huge),
  ];
}

/** Wall-clock ms of `runs` sequential runs of `op`, after `warmups` unmeasured ones. */
export async function measure(op: PerfOp, runs = RUNS, warmups = WARMUPS): Promise<number[]> {
  for (let i = 0; i < warmups; i++) await op.run();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await op.run();
    samples.push(performance.now() - start);
  }
  return samples;
}

export async function benchmark(ops: readonly PerfOp[]): Promise<Record<string, OpStats>> {
  const results: Record<string, OpStats> = {};
  for (const op of ops) results[op.name] = summarize(await measure(op));
  return results;
}
