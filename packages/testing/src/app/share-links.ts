import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn, type SeededUser } from "./sign-in.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/pdfs");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const WAIT = { timeout: 20_000 };
const PASSWORD = "correct horse battery";

async function reach(ctx: JourneyContext, wait: Promise<unknown>, message: string) {
  const ok = await wait.then(
    () => true,
    () => false,
  );
  ctx.expect(ok, message);
  return ok;
}

async function uploadByApi(ctx: JourneyContext, who: SeededUser, name: string): Promise<string> {
  const res = await ctx.page.request.post(
    new URL(`/api/documents?filename=${name}`, ctx.baseUrl).toString(),
    {
      headers: { authorization: `Bearer ${who.token}`, "content-type": "application/pdf" },
      data: readFileSync(join(FIXTURES, name)),
    },
  );
  if (res.status() !== 201) throw new Error(`upload ${name} returned ${String(res.status())}`);
  return ((await res.json()) as { document: { id: string } }).document.id;
}

async function pagesRendered(ctx: JourneyContext, pages: number, where: string) {
  const rendered = ctx.page.locator('[data-testid="page"][data-rendered="true"]');
  await reach(
    ctx,
    rendered.nth(pages - 1).waitFor(WAIT),
    `${where}: did not render ${String(pages)} pages`,
  );
  const count = await rendered.count();
  ctx.expect(
    count === pages,
    `${where}: rendered ${String(count)} pages, expected ${String(pages)}`,
  );
}

/** Opens the Share dialog, fills it, creates the link and returns its URL. */
async function createLink(
  ctx: JourneyContext,
  options: { expiry: string; password?: string; allowDownload: boolean },
  checkpoint?: string,
): Promise<string> {
  const { page } = ctx;
  await page.getByRole("button", { name: "Share with a link" }).click();
  const dialog = page.getByRole("dialog");
  await reach(ctx, dialog.waitFor(WAIT), "the Share dialog did not open");
  await dialog.getByLabel("Link expires after").selectOption({ label: options.expiry });
  if (options.password !== undefined) {
    await dialog.getByLabel("Password (optional)").fill(options.password);
  }
  await dialog.getByLabel("Allow download").setChecked(options.allowDownload);
  if (checkpoint) await ctx.checkpoint(checkpoint);
  await dialog.getByRole("button", { name: "Create link" }).click();
  const field = dialog.getByLabel("Share link");
  await reach(ctx, field.waitFor(WAIT), "no link was shown after Create link");
  const url = await field.inputValue().catch(() => "");
  ctx.expect(
    /\/s\/[A-Za-z0-9_-]{43}$/.test(url),
    `the created link ${url} is not /s/ and a 256-bit token`,
  );
  if (checkpoint) await ctx.checkpoint(`${checkpoint}-created`);
  await dialog.getByRole("button", { name: "Done" }).click();
  return url;
}

function signOut(ctx: JourneyContext) {
  return ctx.page.setExtraHTTPHeaders({});
}

const J011: Journey = {
  id: "J-011",
  title: "Share a Document with a secure link",
  expectedClientErrors: [
    { status: 401, path: /^\/api\/share\/[\w-]{43}\/unlock$/ },
    { status: 404, path: /^\/api\/share\/[\w-]{43}$/ },
  ],
  async run(ctx) {
    const { page, baseUrl, expect } = ctx;
    const owner = await signedIn(ctx, { plan: "pro" });
    const id = await uploadByApi(ctx, owner, "10p.pdf");
    await page.goto(new URL(`/documents/${id}`, baseUrl).toString());
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "10p" }).waitFor(WAIT),
      "the viewer did not open",
    );

    const open = await createLink(ctx, { expiry: "7 days", allowDownload: true }, "share");
    const locked = await createLink(ctx, {
      expiry: "Never",
      password: PASSWORD,
      allowDownload: false,
    });
    const listed = page.getByTestId("document-share-links").getByRole("listitem");
    await reach(ctx, listed.nth(1).waitFor(WAIT), "the viewer does not list both links");

    await signOut(ctx);
    await page.goto(open);
    await pagesRendered(ctx, 10, "open link");
    expect(
      (await page.getByTestId("app-shell").count()) === 0,
      "the share page shows the signed-in app shell",
    );
    await ctx.checkpoint("shared");
    const [download] = await Promise.all([
      page.waitForEvent("download", WAIT),
      page.getByRole("link", { name: "Download" }).click(),
    ]);
    const saved = join(ctx.outDir, "J-011-download.pdf");
    await download.saveAs(saved);
    expect(
      download.suggestedFilename() === "10p.pdf",
      `download named ${download.suggestedFilename()}`,
    );
    expect(
      sha256(readFileSync(saved)) === sha256(readFileSync(join(FIXTURES, "10p.pdf"))),
      "the shared download differs from fixtures/pdfs/10p.pdf (sha256)",
    );

    await page.goto(locked);
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "This document is protected" }).waitFor(WAIT),
      "the password link did not ask for a password",
    );
    expect(
      (await page.getByText("10p").count()) === 0,
      "the locked page names the Document before the password is entered",
    );
    await ctx.checkpoint("locked");
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Open document" }).click();
    await reach(
      ctx,
      page.getByText("That password is not right").waitFor(WAIT),
      "a wrong password was not refused",
    );
    await ctx.checkpoint("wrong-password");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Open document" }).click();
    await pagesRendered(ctx, 10, "password link");
    expect(
      (await page.getByRole("link", { name: "Download" }).count()) === 0,
      "Download is offered on a link with download off",
    );
    const token = new URL(locked).pathname.split("/").pop() ?? "";
    const disposition = await page.evaluate<string>(
      `fetch('/api/share/${token}/content?download=1').then((r) => r.headers.get('content-disposition') ?? '')`,
    );
    expect(disposition.startsWith("inline"), `download-off content is "${disposition}"`);
    await ctx.checkpoint("unlocked");

    await page.setExtraHTTPHeaders({ authorization: `Bearer ${owner.token}` });
    await page.goto(new URL("/links", baseUrl).toString());
    const rows = page.getByTestId("share-link-row");
    await reach(ctx, rows.nth(1).waitFor(WAIT), "/links does not list both links");
    const opens = await page.getByTestId("share-link-opens").allTextContents();
    expect(
      opens.length === 2 && opens.every((n) => Number(n) >= 1),
      `/links shows opens ${opens.join(", ")}, expected at least 1 each`,
    );
    await ctx.checkpoint("links");
    const openRow = rows.filter({ hasNotText: "Password" });
    await openRow.getByRole("button", { name: /^Revoke/ }).click();
    await reach(
      ctx,
      openRow.getByText("Revoked").waitFor(WAIT),
      "Revoke did not mark the link revoked",
    );

    await signOut(ctx);
    await page.goto(open);
    await reach(
      ctx,
      page
        .getByRole("heading", { level: 1, name: "This link is no longer available" })
        .waitFor(WAIT),
      "a revoked link still opens",
    );
    await ctx.checkpoint("revoked");
  },
};

export const SHARE_JOURNEYS: readonly Journey[] = [J011];
