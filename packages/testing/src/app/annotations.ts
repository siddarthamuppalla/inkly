import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "playwright";

import { verifyFile } from "../pdf/verify.ts";
import type { Journey, JourneyContext } from "./journeys.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/pdfs");
const WAIT = { timeout: 20_000 };
/** The ticket's bound for a change to reach the other browser. */
const LIVE_MS = 2_000;

interface Seeded {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly token: string;
}

const unique = (label: string) =>
  `${label}-${Math.random().toString(36).slice(2, 10)}@verify.inkly.test`;

async function api(
  ctx: JourneyContext,
  method: string,
  path: string,
  init: { token?: string; data?: unknown; body?: Buffer; type?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const res = await ctx.page.request.fetch(new URL(path, ctx.baseUrl).toString(), {
    method,
    headers: {
      ...(init.token && { authorization: `Bearer ${init.token}` }),
      ...(path.startsWith("/__test/") && { "x-test-hooks-secret": ctx.secret ?? "" }),
      ...(init.type && { "content-type": init.type }),
    },
    ...(init.data !== undefined && { data: init.data }),
    ...(init.body && { data: init.body }),
  });
  return { status: res.status(), body: (await res.json().catch(() => ({}))) as unknown };
}

async function latestCode(ctx: JourneyContext, email: string): Promise<string> {
  const { body } = (await api(ctx, "GET", `/__test/outbox?to=${encodeURIComponent(email)}`)) as {
    status: number;
    body: { messages?: { text: string }[] };
  };
  return /\b(\d{6})\b/.exec(body.messages?.[0]?.text ?? "")?.[1] ?? "";
}

/**
 * Signs `page` in through the sign-in page with an emailed code, so it holds a session
 * cookie: browsers send cookies, not an Authorization header, on a WebSocket upgrade.
 */
async function signInWithCode(ctx: JourneyContext, page: Page, email: string) {
  await page.goto(new URL("/sign-in", ctx.baseUrl).toString());
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.getByRole("heading", { level: 1, name: "Check your email" }).waitFor(WAIT);
  await page.getByLabel("Code").fill(await latestCode(ctx, email));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByTestId("user-menu").waitFor(WAIT);
}

/** Waits for `locator` to reach `state`; records how long it took against the live bound. */
async function within(
  ctx: JourneyContext,
  locator: Locator,
  state: "visible" | "hidden",
  what: string,
  limit = LIVE_MS,
): Promise<void> {
  const started = Date.now();
  const ok = await locator
    .first()
    .waitFor({ state, timeout: limit })
    .then(() => true)
    .catch(() => false);
  ctx.expect(ok, `${what} did not happen within ${String(limit)} ms`);
  if (ok)
    ctx.expect(Date.now() - started <= limit, `${what} took ${String(Date.now() - started)} ms`);
}

async function layerBox(page: Page, n: number) {
  const layer = page.locator(`[data-testid="annotation-layer"][data-page="${String(n)}"]`);
  await layer.scrollIntoViewIfNeeded();
  const box = await layer.boundingBox();
  if (!box) throw new Error(`page ${String(n)} has no annotation layer`);
  return box;
}

async function drag(page: Page, n: number, from: [number, number], to: [number, number]) {
  const box = await layerBox(page, n);
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    await page.mouse.move(
      box.x + (from[0] + (to[0] - from[0]) * t) * box.width,
      box.y + (from[1] + (to[1] - from[1]) * t) * box.height,
    );
  }
  await page.mouse.up();
}

const thread = (page: Page, label: string) =>
  page.getByTestId("annotation-thread").filter({ hasText: label });

/** The subtypes of every annotation in the PDF at `file`, read through qpdf. */
function annotationSubtypes(file: string): string[] {
  const qdf = execFileSync("qpdf", ["--qdf", "--object-streams=disable", file, "-"]).toString(
    "latin1",
  );
  return [...qdf.matchAll(/\/Subtype \/(Highlight|Text|Ink)\b/g)].map((m) => m[1] ?? "");
}

const J010: Journey = {
  id: "J-010",
  title: "Annotate and comment, live in two browsers",
  async run(ctx) {
    const { page: a, expect } = ctx;
    const ownerEmail = unique("j010-owner");
    const editorEmail = unique("j010-editor");
    const owner = (
      (await api(ctx, "POST", "/__test/seed", {
        data: { email: ownerEmail, name: "Olive Owner", plan: "pro" },
      })) as { status: number; body: Seeded }
    ).body;
    const invited = await api(ctx, "POST", "/api/tenant/invitations", {
      token: owner.token,
      data: { email: editorEmail, role: "editor" },
    });
    expect(invited.status === 201, `invitation returned ${String(invited.status)}`);
    const editor = (
      (await api(ctx, "POST", "/__test/seed", {
        data: { email: editorEmail, name: "Eddie Editor" },
      })) as { status: number; body: Seeded }
    ).body;
    const mail = (await api(
      ctx,
      "GET",
      `/__test/outbox?to=${encodeURIComponent(editorEmail)}`,
    )) as { status: number; body: { messages?: { text: string }[] } };
    const invitation = /\/invitations\/([A-Za-z0-9_-]+)/.exec(mail.body.messages?.[0]?.text ?? "");
    const accepted = await api(ctx, "POST", `/api/invitations/${invitation?.[1] ?? ""}/accept`, {
      token: editor.token,
    });
    expect(accepted.status === 200, `accepting the invitation returned ${String(accepted.status)}`);
    const uploaded = (await api(ctx, "POST", "/api/documents?filename=10p.pdf", {
      token: owner.token,
      body: readFileSync(join(FIXTURES, "10p.pdf")),
      type: "application/pdf",
    })) as { status: number; body: { document: { id: string } } };
    const docUrl = new URL(`/documents/${uploaded.body.document.id}`, ctx.baseUrl).toString();

    const browser = a.context().browser();
    if (!browser) throw new Error("the journey page has no browser");
    const second = await browser.newContext();
    const b = await second.newPage();
    const bErrors: string[] = [];
    b.on("console", (m) => {
      if (m.type() === "error") bErrors.push(m.text());
    });
    b.on("pageerror", (e) => bErrors.push(`uncaught: ${e.message}`));

    try {
      await signInWithCode(ctx, a, ownerEmail);
      await signInWithCode(ctx, b, editorEmail);
      const switched = await b.evaluate<number, string>(
        (tenantId) =>
          fetch("/api/me/active-tenant", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tenantId }),
          }).then((r) => r.status),
        owner.tenantId,
      );
      expect(switched === 200, `B switching to A's workspace returned ${String(switched)}`);
      for (const p of [a, b]) {
        await p.goto(docUrl);
        await p.locator('[data-testid="page"][data-rendered="true"]').nth(9).waitFor(WAIT);
      }
      await within(
        ctx,
        a.getByTestId("presence").filter({ hasText: "Eddie Editor" }),
        "visible",
        "A sees B's presence",
        5_000,
      );
      await within(
        ctx,
        b.getByTestId("presence").filter({ hasText: "Olive Owner" }),
        "visible",
        "B sees A's presence",
        5_000,
      );
      await ctx.checkpoint("two-viewers");

      await a.getByRole("button", { name: "Highlight", exact: true }).click();
      await drag(a, 1, [0.1, 0.1], [0.6, 0.16]);
      await within(
        ctx,
        thread(a, "Highlight on page 1"),
        "visible",
        "A lists its highlight",
        5_000,
      );
      await within(ctx, b.getByTestId("annotation-highlight"), "visible", "B shows A's highlight");

      await a.getByRole("button", { name: "Note", exact: true }).click();
      const note = await layerBox(a, 2);
      await a.mouse.click(note.x + note.width * 0.5, note.y + note.height * 0.4);
      await a.getByLabel("Note text").fill("Check the date");
      await a.getByRole("button", { name: "Add note" }).click();
      await within(
        ctx,
        b.getByRole("button", { name: "Note by Olive Owner: Check the date" }),
        "visible",
        "B shows A's note",
      );

      await a.getByRole("button", { name: "Ink", exact: true }).click();
      await drag(a, 3, [0.2, 0.2], [0.7, 0.5]);
      await within(ctx, b.getByTestId("annotation-ink"), "visible", "B shows A's ink");
      await a.getByRole("button", { name: "Select", exact: true }).click();

      await thread(b, "Highlight on page 1").getByRole("button", { expanded: false }).click();
      await b.getByLabel("Add a comment").fill("Looks right to me");
      await b.getByRole("button", { name: "Comment", exact: true }).click();
      const highlightA = thread(a, "Highlight on page 1");
      await within(ctx, highlightA.getByText("1 comment"), "visible", "A sees B's comment");
      await highlightA.getByRole("button", { expanded: false }).click();
      const comment = highlightA.getByTestId("comment");
      expect(
        ((await comment.textContent()) ?? "").includes("Eddie Editor"),
        "the comment does not name its author",
      );
      await ctx.checkpoint("thread");

      await a.getByRole("button", { name: "Resolve thread" }).click();
      const resolvedB = thread(b, "Highlight on page 1").getByText("Resolved");
      await within(ctx, resolvedB, "visible", "B sees the thread resolved");
      await a.getByRole("button", { name: "Reopen thread" }).click();
      await within(ctx, resolvedB, "hidden", "B sees the thread reopened");

      await thread(a, "Note on page 2").getByRole("button", { expanded: false }).click();
      await a.getByLabel("Edit note").fill("Check the date twice");
      await a.getByRole("button", { name: "Save note" }).click();
      await within(
        ctx,
        b.getByRole("button", { name: "Note by Olive Owner: Check the date twice" }),
        "visible",
        "B sees the edited note",
      );

      const [download] = await Promise.all([
        a.waitForEvent("download", WAIT),
        a.getByRole("button", { name: "Download with annotations" }).click(),
      ]);
      const saved = join(ctx.outDir, "J-010-annotated.pdf");
      await download.saveAs(saved);
      const verified = verifyFile(saved, { expectPages: 10 });
      expect(verified.ok, `verify-pdf on the annotated download: ${verified.failures.join("; ")}`);
      const subtypes = annotationSubtypes(saved).sort();
      expect(
        JSON.stringify(subtypes) === JSON.stringify(["Highlight", "Ink", "Text"]),
        `the download holds annotations ${JSON.stringify(subtypes)}, expected Highlight, Ink, Text`,
      );
      const versions = (await api(
        ctx,
        "GET",
        `/api/documents/${uploaded.body.document.id}/versions`,
        { token: owner.token },
      )) as { status: number; body: { versions?: unknown[] } };
      expect(versions.body.versions?.length === 1, "Download with annotations created a Version");

      await thread(a, "Ink on page 3").getByRole("button", { expanded: false }).click();
      await a.getByRole("button", { name: "Delete annotation" }).click();
      await within(ctx, b.getByTestId("annotation-ink"), "hidden", "B sees the ink deleted");

      await b.close();
      await within(
        ctx,
        a.getByTestId("presence").filter({ hasText: "Only you" }),
        "visible",
        "A sees B leave",
        5_000,
      );
      await ctx.checkpoint("annotated");
    } finally {
      await second.close();
      expect(bErrors.length === 0, `second browser console errors: ${bErrors.join(" | ")}`);
    }
  },
};

export const ANNOTATION_JOURNEYS: readonly Journey[] = [J010];
