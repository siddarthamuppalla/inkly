import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn } from "./sign-in.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/pdfs");
const fixture = (name: string) => join(FIXTURES, name);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const WAIT = { timeout: 20_000 };

/** Waits for a condition the page should reach, recording a failure instead of throwing. */
async function reach(ctx: JourneyContext, wait: Promise<unknown>, message: string) {
  const ok = await wait.then(
    () => true,
    () => false,
  );
  ctx.expect(ok, message);
  return ok;
}

/** Uploads a fixture from the Documents page and waits for its row. */
async function uploadFromList(ctx: JourneyContext, name: string) {
  const { page } = ctx;
  await page.getByTestId("upload-input").setInputFiles(fixture(name));
  const title = name.replace(/\.pdf$/, "");
  await reach(
    ctx,
    page.getByTestId("document-row").filter({ hasText: title }).waitFor(WAIT),
    `${name} did not appear in the Documents list after upload`,
  );
}

async function openDocuments(ctx: JourneyContext) {
  await ctx.page.goto(new URL("/", ctx.baseUrl).toString());
  await reach(
    ctx,
    ctx.page.getByRole("button", { name: "Upload PDF" }).waitFor(WAIT),
    "the Documents page did not offer Upload PDF",
  );
}

async function pagesRendered(ctx: JourneyContext, pages: number) {
  const { page } = ctx;
  await reach(
    ctx,
    page
      .locator('[data-testid="page"][data-rendered="true"]')
      .nth(pages - 1)
      .waitFor(WAIT),
    `the viewer did not render ${String(pages)} pages`,
  );
  const rendered = await page.locator('[data-testid="page"][data-rendered="true"]').count();
  ctx.expect(
    rendered === pages,
    `viewer rendered ${String(rendered)} pages, expected ${String(pages)}`,
  );
}

const J003: Journey = {
  id: "J-003",
  title: "Upload a PDF, view every page, download it",
  async run(ctx) {
    const { page, expect } = ctx;
    await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "10p.pdf");
    const row = page.getByTestId("document-row").filter({ hasText: "10p" });
    expect(
      (await row.textContent().catch(() => ""))?.includes("10 pages") === true,
      "the Documents list does not show 10 pages for 10p.pdf",
    );
    await ctx.checkpoint("documents");

    await row.getByRole("link", { name: "10p" }).click();
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "10p" }).waitFor(WAIT),
      "the viewer did not open",
    );
    await pagesRendered(ctx, 10);
    await reach(
      ctx,
      page.locator('[data-testid="thumbnail"][data-rendered="true"]').nth(9).waitFor(WAIT),
      "the viewer did not render 10 thumbnails",
    );
    await ctx.checkpoint("viewer");

    const [download] = await Promise.all([
      page.waitForEvent("download", WAIT),
      page.getByRole("button", { name: "Download" }).click(),
    ]);
    const saved = join(ctx.outDir, "J-003-download.pdf");
    await download.saveAs(saved);
    expect(
      download.suggestedFilename() === "10p.pdf",
      `download named ${download.suggestedFilename()}`,
    );
    expect(
      sha256(readFileSync(saved)) === sha256(readFileSync(fixture("10p.pdf"))),
      "downloaded bytes differ from fixtures/pdfs/10p.pdf (sha256)",
    );
  },
};

const J004: Journey = {
  id: "J-004",
  title: "Folders: create, nest, move a Document in, navigate",
  async run(ctx) {
    const { page, expect } = ctx;
    await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "tiny.pdf");

    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByLabel("Folder name").fill("Contracts");
    await page.getByRole("button", { name: "Create folder" }).click();
    const folderLink = page.getByRole("link", { name: "Contracts (folder)" });
    await reach(ctx, folderLink.waitFor(WAIT), "the new folder Contracts is not listed");
    await ctx.checkpoint("folder-created");

    await page.getByTestId("document-row").getByRole("link", { name: "tiny" }).click();
    await page.getByRole("combobox", { name: "Folder" }).selectOption({ label: "Contracts" });
    await page.getByRole("button", { name: "Move", exact: true }).click();
    await reach(
      ctx,
      page.getByText("Now in: Contracts").waitFor(WAIT),
      "the viewer does not show the Document in Contracts after Move",
    );
    await ctx.checkpoint("moved");

    await openDocuments(ctx);
    await reach(ctx, folderLink.waitFor(WAIT), "Contracts is not listed at the top level");
    expect(
      (await page.getByTestId("document-row").count()) === 0,
      "the moved Document is still listed at the top level",
    );
    await folderLink.click();
    await reach(
      ctx,
      page.getByTestId("document-row").filter({ hasText: "tiny" }).waitFor(WAIT),
      "the Document is not listed inside Contracts",
    );
    const crumb = page.getByRole("navigation", { name: "Folder path" });
    expect(
      (await crumb.textContent().catch(() => ""))?.includes("Contracts") === true,
      "the folder path does not name Contracts",
    );

    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByLabel("Folder name").fill("2026");
    await page.getByRole("button", { name: "Create folder" }).click();
    const nested = page.getByRole("link", { name: "2026 (folder)" });
    await reach(ctx, nested.waitFor(WAIT), "the nested folder 2026 is not listed in Contracts");
    await nested.click();
    await reach(
      ctx,
      page.getByRole("heading", { name: "This folder is empty" }).waitFor(WAIT),
      "the nested folder did not open empty",
    );
    expect(
      (await crumb.textContent().catch(() => ""))?.includes("Contracts/2026") === true,
      "the folder path does not read Contracts / 2026",
    );
    await ctx.checkpoint("nested");
  },
};

const J005: Journey = {
  id: "J-005",
  title: "Versions: upload a new version, restore v1 as a new version",
  async run(ctx) {
    const { page, expect } = ctx;
    const who = await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "10p.pdf");
    await page.getByTestId("document-row").getByRole("link", { name: "10p" }).click();
    await pagesRendered(ctx, 10);

    const versions = page.getByTestId("version");
    await page.getByTestId("upload-input").setInputFiles(fixture("tiny.pdf"));
    await reach(ctx, versions.nth(1).waitFor(WAIT), "uploading a new version did not add v2");
    await pagesRendered(ctx, 1);

    await page.getByRole("button", { name: "Restore version 1" }).click();
    await reach(ctx, versions.nth(2).waitFor(WAIT), "restoring v1 did not add v3");
    const first = versions.first();
    const top = (await first.textContent().catch(() => "")) ?? "";
    expect(
      top.includes("Version 3") && top.includes("Current") && top.includes("10 pages"),
      `the newest version reads "${top}", expected Version 3, Current, 10 pages`,
    );
    await pagesRendered(ctx, 10);
    await ctx.checkpoint("restored");

    const id = new URL(page.url()).pathname.split("/").pop() ?? "";
    const content = await page.request.get(
      new URL(`/api/documents/${id}/content`, ctx.baseUrl).toString(),
      { headers: { authorization: `Bearer ${who.token}` } },
    );
    expect(
      sha256(await content.body()) === sha256(readFileSync(fixture("10p.pdf"))),
      "v3's bytes differ from v1 (10p.pdf)",
    );
  },
};

export const DOCUMENT_JOURNEYS: readonly Journey[] = [J003, J004, J005];
