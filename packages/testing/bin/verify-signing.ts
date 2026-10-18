import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { startLocalWorker, type LocalWorker } from "../src/app/local-server.ts";
import { checkSignedEnvelope, SELF_TEST_CASES, type SigningReport } from "../src/signing/check.ts";
import { driveEnvelope, type Driven } from "../src/signing/drive.ts";

const USAGE = `usage:
  verify-signing [--url URL --secret SECRET] [--self-test]`;

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "artifacts/verify-signing");

function printReport(r: SigningReport, indent = ""): void {
  const w = Math.max(...r.checks.map((c) => c.name.length));
  for (const c of r.checks) {
    console.log(`${indent}${c.name.padEnd(w)}  ${c.ok ? "PASS" : "FAIL"}  ${c.detail}`);
  }
}

function printDrive(d: Driven): void {
  console.log(`envelope ${d.envelopeId}: 10p.pdf, 2 signers in sequence`);
  for (const s of d.steps) console.log(`  ${s.name.padEnd(40)} ${String(s.ms).padStart(6)} ms`);
  console.log(`time: upload → 2 signers → signed PDF + certificate: ${String(d.totalMs)} ms`);
}

/** Every case must fail the checks it breaks; the good result must pass, or nothing is proven. */
async function selfTest(d: Driven, good: SigningReport): Promise<boolean> {
  let ok = good.ok;
  if (!good.ok)
    console.log("FAIL the unmodified Envelope does not pass, so the self-test proves nothing");
  for (const c of SELF_TEST_CASES) {
    const r = checkSignedEnvelope(await c.mutate(d.result));
    const failed = r.checks.filter((x) => !x.ok).map((x) => x.name);
    const caught = !r.ok && c.mustFail.every((n) => failed.includes(n));
    ok &&= caught;
    console.log(
      `${caught ? "caught" : "MISSED"}  ${c.name}: failed ${failed.join(", ") || "nothing"} (must fail ${c.mustFail.join(", ")})`,
    );
  }
  return ok;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      secret: { type: "string" },
      "self-test": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  const secret = values.secret ?? process.env["TEST_HOOKS_SECRET"];
  let local: LocalWorker | undefined;
  const log: string[] = [];
  try {
    let target: { baseUrl: string; secret: string };
    if (values.url === undefined) {
      console.log("starting wrangler dev…");
      local = await startLocalWorker(repoRoot, log);
      target = local;
    } else {
      if (secret === undefined) throw new Error("--url needs --secret (or $TEST_HOOKS_SECRET)");
      target = { baseUrl: values.url, secret };
    }
    const d = await driveEnvelope(target.baseUrl, target.secret);
    printDrive(d);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "signed.pdf"), d.result.signedPdf);
    writeFileSync(join(outDir, "seal.pem"), d.result.certificatePem);
    const r = checkSignedEnvelope(d.result);
    printReport(r);
    if (values["self-test"] === true) {
      const ok = await selfTest(d, r);
      console.log(ok ? "verify-signing self-test: PASS" : "verify-signing self-test: FAIL");
      return ok ? 0 : 1;
    }
    console.log(r.ok ? "verify-signing: PASS" : "verify-signing: FAIL");
    return r.ok ? 0 : 1;
  } catch (err) {
    if (local && log.length > 0) console.error(log.join("").split("\n").slice(-40).join("\n"));
    throw err;
  } finally {
    local?.stop();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`verify-signing: FAIL ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
