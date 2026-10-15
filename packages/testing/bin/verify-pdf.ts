import { parseArgs } from "node:util";

import { DEFAULT_THRESHOLD, verifyCorpus, verifyFile, type VerifyOptions } from "../src/index.ts";

const USAGE = `usage:
  verify-pdf <file.pdf> [--expect-pages N] [--golden DIR [--threshold PCT] [--update-golden]]
  verify-pdf --corpus DIR`;

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "expect-pages": { type: "string" },
      golden: { type: "string" },
      threshold: { type: "string" },
      "update-golden": { type: "boolean" },
      corpus: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }

  if (values.corpus !== undefined) {
    const { ok, rows } = verifyCorpus(values.corpus);
    const w = Math.max(...rows.map((r) => r.file.length), 4);
    const e = Math.max(...rows.map((r) => r.expected.length), 8);
    console.log(`${"file".padEnd(w)}  ${"expected".padEnd(e)}  result  actual`);
    for (const r of rows) {
      console.log(
        `${r.file.padEnd(w)}  ${r.expected.padEnd(e)}  ${r.pass ? "PASS  " : "FAIL  "}  ${r.actual}`,
      );
    }
    console.log(
      `${String(rows.filter((r) => r.pass).length)}/${String(rows.length)} fixtures match`,
    );
    return ok ? 0 : 1;
  }

  const file = positionals[0];
  if (file === undefined || positionals.length > 1) {
    console.error(USAGE);
    return 2;
  }
  const opts: {
    -readonly [K in keyof VerifyOptions]: VerifyOptions[K];
  } = {};
  if (values["expect-pages"] !== undefined) {
    const n = Number(values["expect-pages"]);
    if (!Number.isInteger(n) || n < 0) {
      console.error("--expect-pages must be a non-negative integer");
      return 2;
    }
    opts.expectPages = n;
  }
  if (values.golden !== undefined) opts.golden = values.golden;
  if (values["update-golden"] === true) opts.updateGolden = true;
  if (values.threshold !== undefined) {
    const t = Number(values.threshold);
    if (!Number.isFinite(t) || t < 0) {
      console.error("--threshold must be a non-negative number (percent)");
      return 2;
    }
    opts.threshold = t;
  } else if (opts.golden !== undefined) {
    opts.threshold = DEFAULT_THRESHOLD;
  }

  const r = verifyFile(file, opts);
  for (const l of r.lines) console.log(l);
  for (const f of r.failures) console.error(`FAIL ${f}`);
  console.log(r.ok ? "verify-pdf: PASS" : "verify-pdf: FAIL");
  return r.ok ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`verify-pdf: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
