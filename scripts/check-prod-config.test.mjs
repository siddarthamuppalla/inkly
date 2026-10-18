// node --test scripts/check-prod-config.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "check-prod-config.mjs");
const CLEAN_CONFIG = '{ "name": "inkly", "vars": {} }\n';

/** A git repo holding `files` (committed), checked with the script. */
function check(files, config = CLEAN_CONFIG) {
  const repo = mkdtempSync(join(tmpdir(), "prod-config-"));
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
  git("add", ".");
  const wrangler = join(repo, "wrangler.json");
  writeFileSync(wrangler, config);
  return spawnSync("node", [SCRIPT, wrangler, "--repo", repo], { encoding: "utf8" });
}

// Generated per run, so no key material is ever committed.
const pem = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

describe("check-prod-config", () => {
  it("passes this repo as committed", () => {
    const r = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      cwd: join(import.meta.dirname, ".."),
    });
    assert.equal(r.status, 0, r.stderr);
  });

  it("passes a clean config and code that only names the secret", () => {
    const r = check({
      "a.ts": "expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----\\n/);\n",
      "b.md": "Set `SEAL_PRIVATE_KEY` with `wrangler secret put`.\n",
      "c.mjs": "const secrets = { SEAL_PRIVATE_KEY: key.privateKeyPem };\n",
    });
    assert.equal(r.status, 0, r.stderr);
  });

  it("fails when the config enables test hooks", () => {
    const r = check({}, '{ "vars": { "TEST_HOOKS": "enabled" } }\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TEST_HOOKS/);
  });

  it("fails when a committed file holds a PEM private key", () => {
    const r = check({ "seal.pem": pem });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /seal\.pem: holds a private key/);
  });

  it("fails when a committed file assigns SEAL_PRIVATE_KEY a value", () => {
    const body = pem.split("\n").slice(1, 2).join("");
    const r = check({ ".dev.vars": `SEAL_PRIVATE_KEY=${body}\n` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /\.dev\.vars: holds a private key or SEAL_PRIVATE_KEY value/);
  });

  it("fails when the config sets SEAL_PRIVATE_KEY as a var", () => {
    const r = check({}, '{ "vars": { "SEAL_PRIVATE_KEY": "x" } }\n');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SEAL_PRIVATE_KEY/);
  });
});
