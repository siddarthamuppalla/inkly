import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { featureMapIds } from "../src/app/feature-map.ts";
import { JOURNEYS, type Journey } from "../src/app/journeys.ts";
import { startLocalWorker, type LocalWorker } from "../src/app/local-server.ts";
import { routeCoverage, type ApiRoute, type RouteCoverage } from "../src/app/route-coverage.ts";
import { runJourneys, writeSummary, type JourneyResult } from "../src/app/runner.ts";
import { startFixtureServer, type FixtureMode } from "../src/app/self-test-server.ts";

const USAGE = `usage:
  verify-app <J-ID>... [--url URL] [--secret SECRET] [--out DIR]
  verify-app --all [--url URL] [--secret SECRET] [--out DIR]
  verify-app --self-test [--out DIR]`;

const repoRoot = resolve(import.meta.dirname, "../../..");
const featureMap = join(repoRoot, ".claude/skills/verify-app/feature-map.md");

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}-${randomBytes(2).toString("hex")}`;
}

async function seedChecks(
  baseUrl: string,
  secret: string | undefined,
): Promise<{
  notes: string[];
  failures: string[];
}> {
  const notes: string[] = [];
  const failures: string[] = [];
  const url = new URL("/__test/seed", baseUrl).toString();
  const closed = await fetch(url, { method: "POST" });
  if (closed.status === 404) notes.push("Test hooks: `POST /__test/seed` without the secret → 404");
  else
    failures.push(
      `POST /__test/seed without the secret returned ${String(closed.status)}, expected 404`,
    );
  if (secret === undefined) {
    notes.push("Seeding: skipped (no test-hooks secret for this target)");
    return { notes, failures };
  }
  const res = await fetch(url, { method: "POST", headers: { "x-test-hooks-secret": secret } });
  if (res.status !== 201) {
    failures.push(`POST /__test/seed with the secret returned ${String(res.status)}, expected 201`);
    return { notes, failures };
  }
  const body = (await res.json()) as { tenantId?: string; userId?: string };
  notes.push(`Seeded tenant ${String(body.tenantId)} with user ${String(body.userId)}`);
  return { notes, failures };
}

/** The Worker's routes, from the secret-gated `GET /__test/routes`. */
async function apiRoutes(baseUrl: string, secret: string): Promise<ApiRoute[]> {
  const res = await fetch(new URL("/__test/routes", baseUrl), {
    headers: { "x-test-hooks-secret": secret },
  });
  if (res.status !== 200) throw new Error(`GET /__test/routes returned ${String(res.status)}`);
  return ((await res.json()) as { routes: ApiRoute[] }).routes;
}

async function verify(
  ids: string[],
  url: string | undefined,
  secretArg: string | undefined,
  out: string,
  featureMap: string,
  coverage: boolean,
) {
  const listed = new Set(featureMapIds(featureMap));
  const journeys: Journey[] = [];
  for (const id of ids) {
    const j = JOURNEYS.get(id);
    if (!listed.has(id) || !j || j.selfTestOnly === true) {
      console.error(
        !listed.has(id)
          ? `${id} is not in ${relative(repoRoot, featureMap)}`
          : `${id} has no automated journey in packages/testing/src/app/journeys.ts`,
      );
      return 2;
    }
    journeys.push(j);
  }

  const runId = newRunId();
  const outDir = join(out, runId);
  mkdirSync(outDir, { recursive: true });
  const log: string[] = [];
  let local: LocalWorker | undefined;
  try {
    let baseUrl = url;
    let secret = secretArg;
    if (baseUrl === undefined) {
      console.log("starting wrangler dev (TEST_HOOKS=enabled, random secret)…");
      local = await startLocalWorker(repoRoot, log);
      baseUrl = local.baseUrl;
      secret = local.secret;
    }
    const seed = await seedChecks(baseUrl, secret);
    const results = await runJourneys(journeys, baseUrl, outDir, secret);
    const all: JourneyResult[] = results;
    const failures = [...seed.failures];
    let covered: RouteCoverage[] | undefined;
    if (coverage) {
      if (secret === undefined) {
        failures.push("--all needs the test-hooks secret to read the API's routes");
      } else {
        covered = routeCoverage(
          await apiRoutes(baseUrl, secret),
          new Map(all.map((r) => [r.id, r.requests])),
        );
        for (const c of covered.filter((c) => c.hits === 0)) {
          failures.push(
            `no journey made a successful ${c.route.method} ${c.route.path}: add one to feature-map.md`,
          );
        }
      }
    }
    const notes = [...seed.notes, ...failures.map((f) => `❌ ${f}`)];
    if (url === undefined) notes.push("Server: local `wrangler dev` started by verify-app");
    const summary = writeSummary(
      { runId, baseUrl, outDir, notes, ...(covered && { coverage: covered }) },
      all,
    );
    if (log.length > 0) writeFileSync(join(outDir, "wrangler.log"), log.join(""));
    const ok = failures.length === 0 && all.every((r) => r.ok);
    for (const r of all) {
      console.log(
        `${r.ok ? "PASS" : "FAIL"} ${r.id} ${r.title}${r.ok ? "" : `: ${r.failures.join("; ")}`}`,
      );
      for (const t of r.timings) console.log(`  time: ${t.name}: ${String(t.ms)} ms`);
      // CI artifacts can be hard to reach, so a failure carries its last API calls in the log.
      if (!r.ok) {
        for (const e of [...r.consoleErrors, ...r.failedRequests]) console.log(`  ! ${e}`);
        for (const q of r.requests.filter((q) => q.path.startsWith("/api/")).slice(-15)) {
          console.log(`  ${q.method} ${q.path} ${String(q.status)}`);
        }
      }
    }
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`artifacts: ${relative(process.cwd(), outDir) || "."}`);
    console.log(`summary: ${relative(process.cwd(), summary)}`);
    console.log(ok ? "verify-app: PASS" : "verify-app: FAIL");
    return ok ? 0 : 1;
  } finally {
    local?.stop();
  }
}

async function selfTest(out: string) {
  const jfail = JOURNEYS.get("J-FAIL");
  if (!jfail) throw new Error("J-FAIL journey missing");
  const runId = `${newRunId()}-self-test`;
  const cases: { mode: FixtureMode; expect: "pass" | "console" | "5xx" | "a11y" }[] = [
    { mode: "clean", expect: "pass" },
    { mode: "console-error", expect: "console" },
    { mode: "server-error", expect: "5xx" },
    { mode: "a11y-violation", expect: "a11y" },
  ];
  let ok = true;
  for (const c of cases) {
    const { url, server } = await startFixtureServer(c.mode);
    try {
      const outDir = join(out, runId, c.mode);
      const [r] = await runJourneys([jfail], url, outDir);
      if (!r) throw new Error("no result");
      writeSummary({ runId: `${runId}/${c.mode}`, baseUrl: url, outDir, notes: [] }, [r]);
      const got = r.ok
        ? "pass"
        : r.consoleErrors.length > 0 && r.serverErrors.length === 0
          ? "console"
          : r.serverErrors.length > 0
            ? "5xx"
            : r.a11yViolations.length > 0
              ? "a11y"
              : "other";
      const good = got === c.expect;
      ok &&= good;
      console.log(
        `${good ? "ok  " : "BAD "} J-FAIL on ${c.mode} page: expected ${c.expect}, got ${got}${r.ok ? "" : ` (${r.failures.join("; ")})`}`,
      );
    } finally {
      server.close();
    }
  }
  console.log(`artifacts: ${relative(process.cwd(), join(out, runId))}`);
  console.log(ok ? "verify-app self-test: PASS" : "verify-app self-test: FAIL");
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      secret: { type: "string" },
      out: { type: "string" },
      "self-test": { type: "boolean" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  const out = resolve(values.out ?? join(repoRoot, "artifacts/verify-app"));
  if (values["self-test"] === true) return selfTest(out);
  const all = values.all === true;
  if (all === positionals.length > 0) {
    console.error(USAGE);
    return 2;
  }
  const secret = values.secret ?? process.env["TEST_HOOKS_SECRET"];
  const ids = all ? featureMapIds(featureMap) : positionals;
  if (all) {
    const listed = new Set(ids);
    const unlisted = [...JOURNEYS.values()].filter(
      (j) => j.selfTestOnly !== true && !listed.has(j.id),
    );
    if (unlisted.length > 0) {
      console.error(
        `journeys with no row in feature-map.md: ${unlisted.map((j) => j.id).join(", ")}`,
      );
      return 2;
    }
  }
  return verify(ids, values.url, secret, out, featureMap, all);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`verify-app: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
