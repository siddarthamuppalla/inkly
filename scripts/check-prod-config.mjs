// Q11: production Worker config must never enable test hooks. Fails if
// workers/api/wrangler.jsonc mentions TEST_HOOKS anywhere (vars, env blocks, comments),
// PDF_ENGINE_URL (the local-dev stand-in for the pdf-engine Container) or SEAL_PRIVATE_KEY
// (a secret, never a var). T3.5: also fails if any file committed in the repo holds a PEM
// private key or a SEAL_PRIVATE_KEY value; the seal key lives only in Worker secrets.
// usage: node scripts/check-prod-config.mjs [path-to-wrangler.jsonc] [--repo DIR]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: "string" } },
});
const file = positionals[0] ?? "workers/api/wrangler.jsonc";
const repo = values.repo ?? join(import.meta.dirname, "..");
let failed = false;

const hits = readFileSync(file, "utf8")
  .split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) =>
    /TEST_HOOKS|VERIFY_TENANCY_SELFTEST|PDF_ENGINE_URL|SEAL_PRIVATE_KEY/.test(line),
  );
if (hits.length > 0) {
  for (const { line, n } of hits) console.error(`${file}:${String(n)}: ${line.trim()}`);
  console.error(
    "prod-config: FAIL — test hooks and secrets must not appear in production config (Q11)",
  );
  failed = true;
}

// A PEM header followed by key material, or SEAL_PRIVATE_KEY assigned a PEM or base64 value.
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/;
const SEAL_VALUE = /SEAL_PRIVATE_KEY["']?\s*[=:]\s*["'`]?(?:-----BEGIN|[A-Za-z0-9+/]{40,})/;

const listed = spawnSync("git", ["-C", repo, "ls-files", "-z"], { encoding: "utf8" });
if (listed.status !== 0) {
  console.error(`prod-config: FAIL — git ls-files in ${repo}: ${listed.stderr.trim()}`);
  process.exit(1);
}
const leaks = listed.stdout
  .split("\0")
  .filter((f) => f !== "")
  .filter((f) => {
    let text;
    try {
      text = readFileSync(join(repo, f), "utf8");
    } catch {
      return false;
    }
    return PRIVATE_KEY.test(text) || SEAL_VALUE.test(text);
  });
if (leaks.length > 0) {
  for (const f of leaks) console.error(`${f}: holds a private key or SEAL_PRIVATE_KEY value`);
  console.error("prod-config: FAIL — the seal key belongs in Worker secrets only (T3.5)");
  failed = true;
}

if (failed) process.exit(1);
console.log(`prod-config: ok — ${file} has no TEST_HOOKS; no committed private key`);
