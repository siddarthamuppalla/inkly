// Q11: production Worker config must never enable test hooks. Fails if
// workers/api/wrangler.jsonc mentions TEST_HOOKS anywhere (vars, env blocks, comments).
// usage: node scripts/check-prod-config.mjs [path-to-wrangler.jsonc]
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "workers/api/wrangler.jsonc";
const hits = readFileSync(file, "utf8")
  .split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => /TEST_HOOKS|VERIFY_TENANCY_SELFTEST/.test(line));

if (hits.length > 0) {
  for (const { line, n } of hits) console.error(`${file}:${String(n)}: ${line.trim()}`);
  console.error("prod-config: FAIL — test hooks must not appear in production config (Q11)");
  process.exit(1);
}
console.log(`prod-config: ok — ${file} has no TEST_HOOKS`);
