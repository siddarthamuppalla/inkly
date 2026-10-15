import type { Page } from "playwright";

export interface JourneyContext {
  readonly page: Page;
  readonly baseUrl: string;
  /** Records a failed expectation; the journey keeps going so the report is complete. */
  readonly expect: (condition: boolean, message: string) => void;
  readonly screenshot: (name: string) => Promise<void>;
}

export interface Journey {
  readonly id: string;
  readonly title: string;
  /** Fixture journeys exist only for `--self-test` and never appear in feature-map.md. */
  readonly selfTestOnly?: boolean;
  readonly run: (ctx: JourneyContext) => Promise<void>;
}

interface HealthBody {
  ok?: unknown;
  d1?: unknown;
  r2?: unknown;
  kv?: unknown;
}

const J000: Journey = {
  id: "J-000",
  title: "Health check",
  async run({ page, baseUrl, expect, screenshot }) {
    const res = await page.request.get(new URL("/health", baseUrl).toString());
    expect(res.status() === 200, `GET /health returned ${String(res.status())}, expected 200`);
    const body = (await res.json().catch(() => ({}))) as HealthBody;
    for (const key of ["ok", "d1", "r2", "kv"] as const) {
      expect(body[key] === true, `GET /health: ${key} is ${String(body[key])}, expected true`);
    }

    await page.goto(new URL("/", baseUrl).toString());
    const shell = page.getByTestId("app-shell");
    await shell.waitFor({ timeout: 10_000 }).catch(() => undefined);
    expect(await shell.isVisible(), "SPA shell [data-testid=app-shell] did not render");
    const health = page.getByTestId("api-health");
    await health
      .filter({ hasText: "API: ok" })
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    expect(
      (await health.textContent().catch(() => null)) === "API: ok",
      "SPA did not report API: ok",
    );
    await screenshot("home");
  },
};

const JFAIL: Journey = {
  id: "J-FAIL",
  title: "Self-test fixture: open the page and let the error checks judge it",
  selfTestOnly: true,
  async run({ page, baseUrl, screenshot }) {
    await page.goto(new URL("/", baseUrl).toString());
    await page.waitForLoadState("networkidle");
    await screenshot("page");
  },
};

export const JOURNEYS: ReadonlyMap<string, Journey> = new Map([J000, JFAIL].map((j) => [j.id, j]));
