import type { Locator, Page } from "playwright";

import { COMPRESS_JOURNEYS } from "./compress.ts";
import { DOCUMENT_JOURNEYS, openDocuments, reach, uploadFromList, WAIT } from "./documents.ts";
import { J009 } from "./forms.ts";
import { PAGE_OP_JOURNEYS } from "./page-ops.ts";
import { signedIn } from "./sign-in.ts";

export interface JourneyContext {
  readonly page: Page;
  readonly baseUrl: string;
  /** The target's test-hooks secret, when the run has one (needed to seed and sign in). */
  readonly secret: string | undefined;
  /** This run's artifact directory, for files a journey keeps (e.g. a download). */
  readonly outDir: string;
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
  /**
   * 4xx responses this journey causes on purpose (status and exact path). Chromium logs
   * them as console errors; listed ones are reported but do not fail the journey.
   */
  readonly expectedClientErrors?: readonly { readonly status: number; readonly path: string }[];
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
  // Signed out, the auth guard's GET /api/me answers 401 and sends the visitor to /sign-in.
  expectedClientErrors: [{ status: 401, path: "/api/me" }],
  async run({ page, baseUrl, expect, checkpoint }) {
    const res = await page.request.get(new URL("/health", baseUrl).toString());
    expect(res.status() === 200, `GET /health returned ${String(res.status())}, expected 200`);
    const body = (await res.json().catch(() => ({}))) as HealthBody;
    for (const key of ["ok", "d1", "r2", "kv"] as const) {
      expect(body[key] === true, `GET /health: ${key} is ${String(body[key])}, expected true`);
    }

    // Signed out, "/" sends the visitor to /sign-in, which is part of the SPA too.
    await page.goto(new URL("/", baseUrl).toString());
    const shell = page.getByTestId("app-shell").or(page.getByTestId("sign-in"));
    await shell.waitFor({ timeout: 10_000 }).catch(() => undefined);
    expect(
      await shell.isVisible(),
      "SPA did not render [data-testid=app-shell] or [data-testid=sign-in]",
    );
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

/** The newest Outbox email for `to`, read through `/__test/outbox`. */
async function latestMail(ctx: JourneyContext, to: string): Promise<string> {
  const url = new URL("/__test/outbox", ctx.baseUrl);
  url.searchParams.set("to", to);
  const res = await ctx.page.request.get(url.toString(), {
    headers: { "x-test-hooks-secret": ctx.secret ?? "" },
  });
  const body = (await res.json().catch(() => ({}))) as { messages?: { text: string }[] };
  return body.messages?.[0]?.text ?? "";
}

function uniqueEmail(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 10)}@verify.inkly.test`;
}

interface MeBody {
  user?: { email?: string };
  activeTenant?: { id?: string; name?: string } | null;
  role?: string | null;
}

/** `GET /api/me` from inside the page, so it carries the page's cookie or bearer header. */
async function apiMe(ctx: JourneyContext): Promise<{ status: number; body: MeBody }> {
  return ctx.page.evaluate<{ status: number; body: MeBody }>(
    "fetch('/api/me').then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }))",
  );
}

const visible = (l: Locator) =>
  l
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

const J002: Journey = {
  id: "J-002",
  title: "Sign in with an email code",
  expectedClientErrors: [{ status: 401, path: "/api/me" }],
  async run(ctx) {
    const { page, baseUrl, expect, checkpoint } = ctx;
    await page.goto(new URL("/", baseUrl).toString());
    expect(
      await visible(page.getByRole("heading", { level: 1, name: "Sign in to Inkly" })),
      "signed-out / did not show the sign-in page",
    );
    expect(new URL(page.url()).pathname === "/sign-in", `signed-out / landed on ${page.url()}`);
    expect(
      (await page.getByRole("button", { name: "Continue with Google" }).count()) === 0,
      "Google is offered although GOOGLE_CLIENT_ID is unset",
    );
    await checkpoint("sign-in");

    const email = uniqueEmail("j002");
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a code" }).click();
    expect(
      await visible(page.getByRole("heading", { level: 1, name: "Check your email" })),
      "code step did not appear",
    );
    await checkpoint("code");

    const code = /\b(\d{6})\b/.exec(await latestMail(ctx, email))?.[1] ?? "";
    expect(code !== "", `no sign-in code in the Outbox for ${email}`);
    await page.getByLabel("Code").fill(code);
    await page.getByRole("button", { name: "Sign in" }).click();
    expect(await visible(page.getByTestId("user-menu")), "user menu did not appear after sign-in");
    expect(new URL(page.url()).pathname === "/", `signed in at ${page.url()}, expected /`);

    const name = email.split("@")[0] ?? "";
    const { body: me } = await apiMe(ctx);
    expect(me.user?.email === email, `GET /api/me user is ${String(me.user?.email)}`);
    expect(
      me.activeTenant?.name === `${name}'s workspace`,
      `Active tenant is ${String(me.activeTenant?.name)}, expected ${name}'s workspace`,
    );
    expect(me.role === "owner", `role is ${String(me.role)}, expected owner`);
    // Backend: Better-Auth's own session endpoint reads the cookie the code sign-in set.
    const session = await page.evaluate<{ user?: { email?: string } } | null>(
      "fetch('/api/auth/get-session').then((r) => r.json()).catch(() => null)",
    );
    expect(
      session?.user?.email === email,
      `GET /api/auth/get-session user is ${String(session?.user?.email)}`,
    );
    const workspace = page.getByTestId("user-menu").getByLabel("Workspace");
    expect(
      (await workspace.locator("option:checked").textContent()) === `${name}'s workspace`,
      "workspace menu does not show the new workspace",
    );
    await checkpoint("signed-in");

    // The document journeys sign in with a seeded bearer token; this one proves the
    // real cookie session from the email code can upload too.
    await openDocuments(ctx);
    await uploadFromList(ctx, "tiny.pdf");
    expect(
      await visible(page.getByTestId("document-row").filter({ hasText: "tiny" })),
      "a PDF uploaded with the cookie session is not listed",
    );
    await checkpoint("uploaded");

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL("**/sign-in", { timeout: 10_000 }).catch(() => undefined);
    expect(new URL(page.url()).pathname === "/sign-in", `after sign-out at ${page.url()}`);
    const after = await page.request.get(new URL("/api/me", baseUrl).toString());
    expect(after.status() === 401, `GET /api/me after sign-out returned ${String(after.status())}`);
  },
};

const J008: Journey = {
  id: "J-008",
  title: "Invite a member",
  // The Free workspace's invitation is refused with 402 limit_exceeded.
  expectedClientErrors: [{ status: 402, path: "/api/tenant/invitations" }],
  async run(ctx) {
    const { page, baseUrl, expect, checkpoint } = ctx;
    const owner = await signedIn(ctx, { plan: "pro" });
    await page.goto(new URL("/members", baseUrl).toString());
    const members = page.getByTestId("member-list");
    expect(await visible(members.getByText(owner.email)), "members page does not list the owner");
    await checkpoint("members");

    const invitee = uniqueEmail("j008");
    await page.getByLabel("Email").fill(invitee);
    await page.getByRole("button", { name: "Send invitation" }).click();
    expect(
      await visible(page.getByRole("status").getByText(`Invitation sent to ${invitee}.`)),
      "no confirmation after sending the invitation",
    );
    expect(
      await visible(page.getByTestId("invitation-list").getByText(invitee)),
      "the invitation is not listed as waiting",
    );
    await checkpoint("invited");

    const link = /https?:\/\/\S+\/invitations\/\S+/.exec(await latestMail(ctx, invitee))?.[0];
    expect(link !== undefined, `no invitation link in the Outbox for ${invitee}`);
    await signedIn(ctx, { email: invitee });
    await page.goto(new URL(new URL(link ?? "/", baseUrl).pathname, baseUrl).toString());
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.waitForURL(`${baseUrl}/`, { timeout: 10_000 }).catch(() => undefined);
    expect(await visible(page.getByTestId("user-menu")), "user menu missing after accepting");
    const { body: me } = await apiMe(ctx);
    expect(
      me.activeTenant?.id === owner.tenantId,
      `invitee's Active tenant is ${String(me.activeTenant?.id)}, expected ${owner.tenantId}`,
    );
    expect(me.role === "editor", `invitee role is ${String(me.role)}, expected editor`);
    await page.goto(new URL("/members", baseUrl).toString());
    expect(
      await visible(page.getByTestId("member-list").getByText(invitee)),
      "the invitee is not listed as a member",
    );
    await checkpoint("joined");

    await signedIn(ctx);
    await page.goto(new URL("/members", baseUrl).toString());
    await page.getByLabel("Email").fill(uniqueEmail("j008-free"));
    const refused = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === "/api/tenant/invitations",
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "Send invitation" }).click();
    expect((await refused).status() === 402, "the Free invitation did not return 402");
    expect(
      await visible(page.getByText("The Free plan allows 1 member")),
      "a Free workspace did not refuse a second member",
    );
    await checkpoint("free-limit");
  },
};

const J015: Journey = {
  id: "J-015",
  title: "Switch workspace and remove a member",
  async run(ctx) {
    const { page, baseUrl, expect, checkpoint } = ctx;
    const owner = await signedIn(ctx, { plan: "pro" });
    await page.goto(new URL("/members", baseUrl).toString());
    const invitee = uniqueEmail("j015");
    await page.getByLabel("Email").fill(invitee);
    await page.getByRole("button", { name: "Send invitation" }).click();
    expect(
      await visible(page.getByRole("status").getByText(`Invitation sent to ${invitee}.`)),
      "no confirmation after sending the invitation",
    );
    const link = /https?:\/\/\S+\/invitations\/\S+/.exec(await latestMail(ctx, invitee))?.[0];
    expect(link !== undefined, `no invitation link in the Outbox for ${invitee}`);

    const member = await signedIn(ctx, { email: invitee });
    await page.goto(new URL(new URL(link ?? "/", baseUrl).pathname, baseUrl).toString());
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.waitForURL(`${baseUrl}/`, { timeout: 10_000 }).catch(() => undefined);
    const joined = await apiMe(ctx);
    expect(
      joined.body.activeTenant?.id === owner.tenantId,
      `after accepting, Active tenant is ${String(joined.body.activeTenant?.id)}, expected ${owner.tenantId}`,
    );

    const workspace = page.getByRole("combobox", { name: "Workspace" });
    // Switching reloads the page once the API answers; read /api/me only after that reload.
    const reloaded = page.waitForEvent("framenavigated", {
      predicate: (f) => f === page.mainFrame(),
      ...WAIT,
    });
    await workspace.selectOption(member.tenantId);
    await reach(ctx, reloaded, "the page did not reload after switching workspace");
    await page.waitForLoadState("load");
    const switched = await apiMe(ctx);
    expect(
      switched.body.activeTenant?.id === member.tenantId && switched.body.role === "owner",
      `after switching, Active tenant is ${String(switched.body.activeTenant?.id)} as ${String(switched.body.role)}, expected ${member.tenantId} as owner`,
    );
    expect(
      (await workspace.inputValue().catch(() => "")) === member.tenantId,
      "the Workspace menu does not show the workspace switched to",
    );
    await checkpoint("switched");

    await page.setExtraHTTPHeaders({ authorization: `Bearer ${owner.token}` });
    await page.goto(new URL("/members", baseUrl).toString());
    const members = page.getByTestId("member-list");
    expect(await visible(members.getByText(invitee)), "the invitee is not listed as a member");
    await members.getByRole("button", { name: `Remove ${invitee}` }).click();
    // A real deploy can take longer than `visible`'s 10 s to remove a member.
    const removed = page.getByRole("status").getByText(`${invitee} was removed.`);
    expect(
      await removed.waitFor(WAIT).then(
        () => true,
        () => false,
      ),
      "no confirmation after removing the member",
    );
    // One row per member; the email also sits in its Remove button's label.
    expect(
      await members
        .getByRole("listitem")
        .filter({ hasText: invitee })
        .waitFor({ ...WAIT, state: "detached" })
        .then(
          () => true,
          () => false,
        ),
      "the removed member is still listed",
    );
    await checkpoint("removed");
  },
};

export const JOURNEYS: ReadonlyMap<string, Journey> = new Map(
  [
    J000,
    J001,
    J002,
    ...DOCUMENT_JOURNEYS,
    ...PAGE_OP_JOURNEYS,
    ...COMPRESS_JOURNEYS,
    J008,
    J009,
    J015,
    JFAIL,
  ].map((j) => [j.id, j]),
);
