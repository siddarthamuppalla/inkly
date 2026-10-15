import type { Page } from "playwright";

export interface JourneyContext {
  readonly page: Page;
  readonly baseUrl: string;
  /** Records a failed expectation; the journey keeps going so the report is complete. */
  readonly expect: (condition: boolean, message: string) => void;
  /** Screenshots the page in light and dark schemes and runs an axe WCAG 2.1 A/AA scan of each. */
  readonly checkpoint: (name: string) => Promise<void>;
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
  async run({ page, baseUrl, expect, checkpoint }) {
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
    await checkpoint("home");
  },
};

const JFAIL: Journey = {
  id: "J-FAIL",
  title: "Self-test fixture: open the page and let the error checks judge it",
  selfTestOnly: true,
  async run({ page, baseUrl, checkpoint }) {
    await page.goto(new URL("/", baseUrl).toString());
    await page.waitForLoadState("networkidle");
    await checkpoint("page");
  },
};

/** The slice of `window` J-001 reads inside the page; this package compiles without the DOM lib. */
interface BrowserGlobals {
  getComputedStyle(el: unknown): { outlineStyle: string; outlineWidth: string };
}

const J001: Journey = {
  id: "J-001",
  title: "Design system reference",
  async run({ page, baseUrl, expect, checkpoint }) {
    await page.goto(new URL("/design", baseUrl).toString());
    const heading = page.getByRole("heading", { level: 1, name: "Design system" });
    await heading.waitFor({ timeout: 10_000 }).catch(() => undefined);
    expect(await heading.isVisible(), "/design did not render its h1");
    for (const section of ["Color", "Type", "Buttons", "Status", "Fields", "Sheets"]) {
      expect(
        await page.getByRole("heading", { level: 2, name: section }).isVisible(),
        `/design is missing the ${section} section`,
      );
    }
    expect(
      (await page.title()) === "Design system · Inkly",
      `unexpected title ${await page.title()}`,
    );

    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    const focusedText = await focused.textContent().catch(() => null);
    expect(focusedText === "Skip to content", `first Tab focused ${String(focusedText)}`);
    const outline = await focused
      .evaluate((el) => {
        const style = (globalThis as unknown as BrowserGlobals).getComputedStyle(el);
        return [style.outlineStyle, style.outlineWidth] as const;
      })
      .catch(() => ["none", "0px"] as const);
    expect(
      outline[0] !== "none" && parseFloat(outline[1]) >= 2,
      `focused element has no visible outline (${outline.join(" ")})`,
    );
    await checkpoint("design");

    await page.keyboard.press("Enter");
    const afterSkip = await page
      .locator(":focus")
      .getAttribute("id")
      .catch(() => null);
    expect(afterSkip === "main", `skip link moved focus to ${String(afterSkip)}, expected #main`);

    // WCAG 1.4.10 Reflow: at 320 CSS px nothing may need horizontal scrolling.
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    expect(overflow <= 0, `/design scrolls horizontally by ${String(overflow)}px at 320px wide`);
    await checkpoint("design-320");
  },
};

export const JOURNEYS: ReadonlyMap<string, Journey> = new Map(
  [J000, J001, JFAIL].map((j) => [j.id, j]),
);
