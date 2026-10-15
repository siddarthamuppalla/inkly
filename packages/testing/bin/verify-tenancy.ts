import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { startLocalWorker, type LocalWorker } from "../src/app/local-server.ts";
import { attackTenancy, type TenancyReport } from "../src/tenancy/attack.ts";

const USAGE = `usage:
  verify-tenancy [--url URL --secret SECRET]
  verify-tenancy --self-test`;

const repoRoot = resolve(import.meta.dirname, "../../..");

function print(r: TenancyReport): void {
  const w = Math.max(...r.attempts.map((a) => a.name.length));
  console.log(`${"attempt (as tenant A)".padEnd(w)}  status  result`);
  for (const a of r.attempts) {
    console.log(
      `${a.name.padEnd(w)}  ${String(a.status).padEnd(6)}  ${a.denied ? "denied" : "LEAKED"}`,
    );
  }
  console.log(`access-log entries for A: ${String(r.accessLogEntries)}`);
  for (const p of r.problems) console.log(`FAIL ${p}`);
}

async function against(
  url: string | undefined,
  secret: string | undefined,
  vars: Record<string, string>,
): Promise<TenancyReport> {
  let local: LocalWorker | undefined;
  const log: string[] = [];
  try {
    if (url === undefined) {
      local = await startLocalWorker(repoRoot, log, vars);
      return await attackTenancy(local.baseUrl, local.secret);
    }
    if (secret === undefined) throw new Error("--url needs --secret (or $TEST_HOOKS_SECRET)");
    return await attackTenancy(url, secret);
  } finally {
    local?.stop();
  }
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
  if (values["self-test"] === true) {
    console.log("self-test: starting wrangler dev with VERIFY_TENANCY_SELFTEST=leak…");
    const r = await against(undefined, undefined, { VERIFY_TENANCY_SELFTEST: "leak" });
    print(r);
    const leaked = r.attempts.some((a) => !a.denied);
    console.log(
      leaked
        ? "verify-tenancy self-test: PASS (the leak was detected)"
        : "verify-tenancy self-test: FAIL (the leaky build was not caught)",
    );
    return leaked && !r.ok ? 0 : 1;
  }
  const r = await against(values.url, values.secret ?? process.env["TEST_HOOKS_SECRET"], {});
  print(r);
  console.log(r.ok ? "verify-tenancy: PASS" : "verify-tenancy: FAIL");
  return r.ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`verify-tenancy: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
