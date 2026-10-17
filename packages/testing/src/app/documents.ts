import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn } from "./sign-in.ts";

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/pdfs");
export const fixture = (name: string) => join(FIXTURES, name);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const WAIT = { timeout: 20_000 };

/** Waits for a condition the page should reach, recording a failure instead of throwing. */
export async function reach(ctx: JourneyContext, wait: Promise<unknown>, message: string) {
  const ok = await wait.then(
    () => true,
    () => false,
  );
  ctx.expect(ok, message);
  return ok;
}

/** Uploads a fixture from the Documents page and waits for its row. */
export async function uploadFromList(ctx: JourneyContext, name: string) {
  const { page } = ctx;
  await page.getByTestId("upload-input").setInputFiles(fixture(name));
  const title = name.replace(/\.pdf$/, "");
  await reach(
    ctx,
    page.getByTestId("document-row").filter({ hasText: title }).waitFor(WAIT),
    `${name} did not appear in the Documents list after upload`,
  );
}

export async function openDocuments(ctx: JourneyContext) {
  await ctx.page.goto(new URL("/", ctx.baseUrl).toString());
  await reach(
    ctx,
    ctx.page.getByRole("button", { name: "Upload PDF" }).waitFor(WAIT),
    "the Documents page did not offer Upload PDF",
  );
}

/**
 * Waits for the viewer to show exactly `pages` rendered pages. After a write the Document
 * refetches separately from its Version list, so the old Version can still be on screen.
 */
export async function pagesRendered(ctx: JourneyContext, pages: number) {
  const { page } = ctx;
  const ok = await page
    .waitForFunction(
      // A string, since this package's types have no DOM: every page rendered, and no extras.
      `document.querySelectorAll('[data-testid="page"]').length === ${String(pages)} &&
        document.querySelectorAll('[data-testid="page"]:not([data-rendered="true"])').length === 0`,
      undefined,
      WAIT,
    )
    .then(
      () => true,
      () => false,
    );
  if (!ok) {
    const rendered = await page.locator('[data-testid="page"][data-rendered="true"]').count();
    ctx.expect(false, `viewer rendered ${String(rendered)} pages, expected ${String(pages)}`);
  }
}

/** Waits for Version `n` to be the newest, marked Current, with `pages` pages, and on screen. */
export async function currentVersionIs(ctx: JourneyContext, n: number, pages: number) {
  const { page } = ctx;
  const label = pages === 1 ? "1 page" : `${String(pages)} pages`;
  const newest = page.getByTestId("version").first();
  const ok = await newest
    .filter({ hasText: `Version ${String(n)}` })
    .filter({ hasText: "Current" })
    .filter({ hasText: label })
    .waitFor(WAIT)
    .then(
      () => true,
      () => false,
    );
  if (!ok) {
    const top = (await newest.textContent().catch(() => "")) ?? "";
    ctx.expect(
      false,
      `the newest version reads "${top}", expected Version ${String(n)}, Current, ${label}`,
    );
  }
  await pagesRendered(ctx, pages);
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
    await currentVersionIs(ctx, 2, 1);

    await page.getByRole("button", { name: "Restore version 1" }).click();
    await reach(ctx, versions.nth(2).waitFor(WAIT), "restoring v1 did not add v3");
    await currentVersionIs(ctx, 3, 10);
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
    // Backend: an older Version's bytes stay readable after a restore (fetched by the page,
    // so the request counts toward route coverage).
    const v2 = await page.evaluate<string, string>(
      (path) =>
        fetch(path)
          .then((r) => r.arrayBuffer())
          .then((b) => crypto.subtle.digest("SHA-256", b))
          .then((d) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("")),
      `/api/documents/${id}/versions/2/content`,
    );
    expect(v2 === sha256(readFileSync(fixture("tiny.pdf"))), "v2's bytes differ from tiny.pdf");
  },
};

const J013: Journey = {
  id: "J-013",
  title: "Trash: move a Document to Trash and restore it",
  async run(ctx) {
    const { page, expect } = ctx;
    await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "tiny.pdf");
    await page.getByTestId("document-row").getByRole("link", { name: "tiny" }).click();
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await reach(
      ctx,
      page.getByRole("button", { name: "Upload PDF" }).waitFor(WAIT),
      "Move to Trash did not return to Documents",
    );
    await reach(
      ctx,
      page
        .getByTestId("document-row")
        .filter({ hasText: "tiny" })
        .waitFor({ ...WAIT, state: "detached" }),
      "the trashed Document is still listed in Documents",
    );

    await page.getByRole("link", { name: "Trash" }).first().click();
    const row = page.getByTestId("trash-row").filter({ hasText: "tiny" });
    await reach(ctx, row.waitFor(WAIT), "Trash does not list the trashed Document");
    await ctx.checkpoint("trash");
    await row.getByRole("button", { name: "Restore tiny" }).click();
    await reach(
      ctx,
      page.getByRole("heading", { name: "Trash is empty" }).waitFor(WAIT),
      "Trash still lists the Document after Restore",
    );

    await openDocuments(ctx);
    await reach(
      ctx,
      page.getByTestId("document-row").filter({ hasText: "tiny" }).waitFor(WAIT),
      "the restored Document is not back in Documents",
    );
    expect(
      (await page.getByTestId("document-row").count()) === 1,
      "Documents does not list exactly the restored Document",
    );
    await ctx.checkpoint("restored");
  },
};

const J014: Journey = {
  id: "J-014",
  title: "Folders: rename and delete",
  async run(ctx) {
    const { page } = ctx;
    await signedIn(ctx);
    await openDocuments(ctx);
    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByLabel("Folder name").fill("Drafts");
    await page.getByRole("button", { name: "Create folder" }).click();
    await reach(
      ctx,
      page.getByRole("link", { name: "Drafts (folder)" }).waitFor(WAIT),
      "the new folder Drafts is not listed",
    );

    await page.getByRole("button", { name: "Rename folder Drafts" }).click();
    await page.getByLabel("New name for Drafts").fill("Archive");
    await ctx.checkpoint("renaming");
    await page.getByRole("button", { name: "Save" }).click();
    const archive = page.getByRole("link", { name: "Archive (folder)" });
    await reach(ctx, archive.waitFor(WAIT), "the folder does not read Archive after Rename");

    await page.getByRole("button", { name: "Delete folder Archive" }).click();
    await reach(
      ctx,
      archive.waitFor({ ...WAIT, state: "detached" }),
      "the folder Archive is still listed after Delete",
    );
    await ctx.checkpoint("deleted");
  },
};

export const DOCUMENT_JOURNEYS: readonly Journey[] = [J003, J004, J005, J013, J014];
