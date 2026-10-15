import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type LaunchOptions } from "playwright";

import type { Journey } from "./journeys.ts";

export interface JourneyResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly failures: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly serverErrors: readonly string[];
  readonly failedRequests: readonly string[];
  readonly artifacts: readonly string[];
}

export interface RunInfo {
  readonly runId: string;
  readonly baseUrl: string;
  readonly outDir: string;
  readonly notes: readonly string[];
}

function launchOptions(): LaunchOptions {
  // Lets a machine with a pre-installed Chromium skip `playwright install`.
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  return executablePath ? { executablePath } : {};
}

export async function runJourneys(
  journeys: readonly Journey[],
  baseUrl: string,
  outDir: string,
): Promise<JourneyResult[]> {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const results: JourneyResult[] = [];
  try {
    for (const journey of journeys) {
      const failures: string[] = [];
      const consoleErrors: string[] = [];
      const serverErrors: string[] = [];
      const failedRequests: string[] = [];
      const artifacts: string[] = [];
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => consoleErrors.push(`uncaught: ${e.message}`));
      context.on("response", (r) => {
        if (r.status() >= 500) serverErrors.push(`${String(r.status())} ${r.url()}`);
      });
      context.on("requestfailed", (r) => {
        failedRequests.push(`${r.url()}: ${r.failure()?.errorText ?? "failed"}`);
      });

      const started = Date.now();
      try {
        await journey.run({
          page,
          baseUrl,
          expect: (cond, msg) => {
            if (!cond) failures.push(msg);
          },
          screenshot: async (name) => {
            const file = `${journey.id}-${name}.png`;
            await page.screenshot({ path: join(outDir, file), fullPage: true });
            artifacts.push(file);
          },
        });
      } catch (err) {
        failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      const durationMs = Date.now() - started;
      const trace = `${journey.id}-trace.zip`;
      await context.tracing.stop({ path: join(outDir, trace) });
      artifacts.push(trace);
      await context.close();

      if (consoleErrors.length > 0)
        failures.push(`${String(consoleErrors.length)} console error(s)`);
      if (serverErrors.length > 0) failures.push(`${String(serverErrors.length)} 5xx response(s)`);
      results.push({
        id: journey.id,
        title: journey.title,
        ok: failures.length === 0,
        durationMs,
        failures,
        consoleErrors,
        serverErrors,
        failedRequests,
        artifacts,
      });
    }
  } finally {
    await browser.close();
  }
  return results;
}

const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", " ");

export function writeSummary(info: RunInfo, results: readonly JourneyResult[]): string {
  const ok = results.every((r) => r.ok);
  const lines = [
    `# verify-app ${info.runId}`,
    "",
    `- Target: ${info.baseUrl}`,
    `- Result: ${ok ? "PASS" : "FAIL"}`,
    ...info.notes.map((n) => `- ${n}`),
    "",
    "| ID | Journey | Result | Duration | Console errors | 5xx | Artifacts |",
    "|----|---------|--------|---------:|---------------:|----:|-----------|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${cell(r.title)} | ${r.ok ? "✅ pass" : "❌ fail"} | ${String(r.durationMs)} ms | ${String(r.consoleErrors.length)} | ${String(r.serverErrors.length)} | ${r.artifacts.join(", ")} |`,
    ),
  ];
  for (const r of results) {
    const details = [
      ...r.failures.map((f) => `- failure: ${f}`),
      ...r.consoleErrors.map((e) => `- console: ${e}`),
      ...r.serverErrors.map((e) => `- 5xx: ${e}`),
      ...r.failedRequests.map((e) => `- request failed: ${e}`),
    ];
    if (details.length > 0) lines.push("", `## ${r.id}`, "", ...details);
  }
  const file = join(info.outDir, "summary.md");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
