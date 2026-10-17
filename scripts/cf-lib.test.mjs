// node --test scripts/cf-lib.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const CF_LIB = join(import.meta.dirname, "../.claude/skills/cf-deploy-preview/cf-lib.sh");

// wrangler 4.151 prints config warnings on stdout, ahead of `--format json` output.
const POLLUTED_LIST =
  "▲ [WARNING] Processing wrangler.production.json configuration:\n" +
  '    - Unexpected fields found in observability field: "issue_detection"\n' +
  '[{"name":"BETTER_AUTH_SECRET","type":"secret_text"}]';

/** Runs ensure_random_secret with stub curl and wrangler; returns the exit code and stub calls. */
function ensureSecret({ apiBody, existing }) {
  const dir = mkdtempSync(join(tmpdir(), "cf-lib-"));
  const log = join(dir, "calls.log");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >>"${log}"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub("curl", `cat <<'EOF'\n${apiBody}\nEOF`);
  stub("wrangler", `[ "$1 $2" = "secret list" ] && cat <<'EOF'\n${existing}\nEOF\ncat >/dev/null`);
  const res = spawnSync(
    "bash",
    [
      "-c",
      `source "${CF_LIB}"; wrangler="${dir}/wrangler"; ensure_random_secret inkly cfg.json BETTER_AUTH_SECRET`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CLOUDFLARE_API_TOKEN: "t",
        CLOUDFLARE_ACCOUNT_ID: "a",
      },
      encoding: "utf8",
    },
  );
  let calls = "";
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    // no stub was called
  }
  return { status: res.status, stderr: res.stderr, calls };
}

describe("ensure_random_secret", () => {
  it("keeps an existing secret even when wrangler pollutes its JSON output", () => {
    const r = ensureSecret({
      apiBody: '{"success":true,"result":[{"name":"BETTER_AUTH_SECRET","type":"secret_text"}]}',
      existing: POLLUTED_LIST,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /BETTER_AUTH_SECRET present/);
    assert.doesNotMatch(r.calls, /secret put/);
  });

  it("creates the secret when the Worker has none", () => {
    const r = ensureSecret({ apiBody: '{"success":true,"result":[]}', existing: "[]" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.calls, /wrangler secret put BETTER_AUTH_SECRET -c cfg.json/);
  });

  it("refuses to replace the secret when the listing cannot be read", () => {
    const r = ensureSecret({
      apiBody: '{"success":false,"errors":[{"message":"denied"}]}',
      existing: "not json",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing/);
    assert.doesNotMatch(r.calls, /secret put/);
  });
});
