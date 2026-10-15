import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type LaunchOptions, type Page } from "playwright";

import type { Journey } from "./journeys.ts";

export interface JourneyResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly failures: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly serverErrors: readonly string[];
  readonly a11yViolations: readonly string[];
  readonly failedRequests: readonly string[];
  /** 4xx responses the journey declared as designed outcomes; reported, never failed on. */
  readonly expectedClientErrors: readonly string[];
  readonly artifacts: readonly string[];
}

export interface RunInfo {
  readonly runId: string;
  readonly baseUrl: string;
  readonly outDir: string;
  readonly notes: readonly string[];
}

/** WCAG 2.0, 2.1 and 2.2, levels A and AA: the bar Inkly holds itself to. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SCHEMES = ["light", "dark"] as const;

async function axeScan(page: Page, scheme: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return violations.map((v) => {
    const targets = v.nodes.map((n) => n.target.join(" ")).join(", ");
    return `[${scheme}] ${v.id}: ${v.help} (${String(v.nodes.length)} node(s): ${targets})`;
  });
}

function launchOptions(): LaunchOptions {
  // Lets a machine with a pre-installed Chromium skip `playwright install`.
  const executablePath = process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"];
  return executablePath ? { executablePath } : {};
}

const RESOURCE_STATUS = /^Failed to load resource: the server responded with a status of (4\d\d)\b/;

/** Chromium logs every 4xx as a console error; a journey may declare the ones it expects. */
function isExpectedClientError(journey: Journey, text: string, url: string): boolean {
  const status = Number(RESOURCE_STATUS.exec(text)?.[1]);
  if (!status) return false;
  const path = URL.canParse(url) ? new URL(url).pathname : "";
  return (journey.expectedClientErrors ?? []).some((e) => e.status === status && e.path === path);
}

export async function runJourneys(
  journeys: readonly Journey[],
  baseUrl: string,
  outDir: string,
  secret?: string,
): Promise<JourneyResult[]> {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const results: JourneyResult[] = [];
  try {
    for (const journey of journeys) {
      const failures: string[] = [];
      const consoleErrors: string[] = [];
      const serverErrors: string[] = [];
      const a11yViolations: string[] = [];
      const failedRequests: string[] = [];
      const expectedClientErrors: string[] = [];
      const artifacts: string[] = [];
      const context = await browser.newContext();
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if (isExpectedClientError(journey, m.text(), m.location().url)) {
          expectedClientErrors.push(`${m.text()} (${m.location().url})`);
          return;
        }
        consoleErrors.push(m.text());
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
          secret,
          expect: (cond, msg) => {
            if (!cond) failures.push(msg);
          },
          checkpoint: async (name) => {
            for (const scheme of SCHEMES) {
              await page.emulateMedia({ colorScheme: scheme });
              const file = `${journey.id}-${name}-${scheme}.png`;
              await page.screenshot({ path: join(outDir, file), fullPage: true });
              artifacts.push(file);
              a11yViolations.push(...(await axeScan(page, scheme)));
            }
            await page.emulateMedia({ colorScheme: null });
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
      if (a11yViolations.length > 0)
        failures.push(`${String(a11yViolations.length)} accessibility violation(s)`);
      results.push({
        id: journey.id,
        title: journey.title,
        ok: failures.length === 0,
        durationMs,
        failures,
        consoleErrors,
        serverErrors,
        a11yViolations,
        failedRequests,
        expectedClientErrors,
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
    "| ID | Journey | Result | Duration | Console errors | 5xx | A11y | Artifacts |",
    "|----|---------|--------|---------:|---------------:|----:|-----:|-----------|",
    ...results.map(
      (r) =>
        `| ${r.id} | ${cell(r.title)} | ${r.ok ? "✅ pass" : "❌ fail"} | ${String(r.durationMs)} ms | ${String(r.consoleErrors.length)} | ${String(r.serverErrors.length)} | ${String(r.a11yViolations.length)} | ${r.artifacts.join(", ")} |`,
    ),
  ];
  for (const r of results) {
    const details = [
      ...r.failures.map((f) => `- failure: ${f}`),
      ...r.consoleErrors.map((e) => `- console: ${e}`),
      ...r.serverErrors.map((e) => `- 5xx: ${e}`),
      ...r.a11yViolations.map((e) => `- a11y: ${e}`),
      ...r.failedRequests.map((e) => `- request failed: ${e}`),
      ...r.expectedClientErrors.map((e) => `- expected 4xx: ${e}`),
    ];
    if (details.length > 0) lines.push("", `## ${r.id}`, "", ...details);
  }
  const file = join(info.outDir, "summary.md");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}
