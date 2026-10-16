import type { Journey } from "./journeys.ts";
import { openDocuments, pagesRendered, reach, uploadFromList, WAIT } from "./documents.ts";
import { signedIn } from "./sign-in.ts";

/** The first page's canvas is wider than tall: the portrait page has turned a quarter. */
async function firstPageLandscape(ctx: Parameters<Journey["run"]>[0]): Promise<boolean> {
  const canvas = ctx.page.locator('[data-testid="page"][data-rendered="true"]').first();
  await canvas.waitFor(WAIT).catch(() => undefined);
  const box = await canvas.boundingBox();
  return box !== null && box.width > box.height;
}

const J006: Journey = {
  id: "J-006",
  title: "Page edits: rotate, reorder, delete, split, merge",
  async run(ctx) {
    const { page, expect } = ctx;
    await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "tiny.pdf");
    await uploadFromList(ctx, "10p.pdf");
    await page.getByTestId("document-row").getByRole("link", { name: "10p" }).click();
    await pagesRendered(ctx, 10);
    expect(!(await firstPageLandscape(ctx)), "page 1 of 10p.pdf is not portrait before rotating");

    const versions = page.getByTestId("version");
    await page.getByRole("checkbox", { name: "Select page 1", exact: true }).check();
    await page.getByRole("button", { name: "Rotate right" }).click();
    await reach(ctx, versions.nth(1).waitFor(WAIT), "Rotate right did not add Version 2");
    await pagesRendered(ctx, 10);
    expect(await firstPageLandscape(ctx), "page 1 is not landscape after Rotate right");
    await ctx.checkpoint("rotated");

    await page.getByRole("button", { name: "Move page 10 up" }).click();
    await page.getByRole("button", { name: "Save order" }).click();
    await reach(ctx, versions.nth(2).waitFor(WAIT), "Save order did not add Version 3");
    await pagesRendered(ctx, 10);
    const order = await page.getByTestId("edit-page").allTextContents();
    expect(
      order.length === 10 && order.every((text, i) => text.includes(`Page ${String(i + 1)}`)),
      "the page list did not reset to the saved Version's order",
    );

    await page.getByRole("checkbox", { name: "Select page 10", exact: true }).check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await reach(ctx, versions.nth(3).waitFor(WAIT), "Delete did not add Version 4");
    await pagesRendered(ctx, 9);
    const top =
      (await versions
        .first()
        .textContent()
        .catch(() => "")) ?? "";
    expect(
      top.includes("Version 4") && top.includes("Current") && top.includes("9 pages"),
      `the newest version reads "${top}", expected Version 4, Current, 9 pages`,
    );
    await ctx.checkpoint("edited");

    await page.getByLabel("Split into new documents").fill("1-4, 5-9");
    await page.getByRole("button", { name: "Split", exact: true }).click();
    const parts = page.getByRole("list", { name: "New documents" }).getByRole("link");
    await reach(ctx, parts.nth(1).waitFor(WAIT), "Split did not list two new documents");
    const titles = await parts.allTextContents();
    expect(
      titles.join("|") === "10p (pp. 1-4)|10p (pp. 5-9)",
      `split made ${JSON.stringify(titles)}`,
    );

    await page.getByRole("combobox", { name: "Merge with" }).selectOption({ label: "tiny" });
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "10p + tiny" }).waitFor(WAIT),
      "Merge did not open the new document 10p + tiny",
    );
    await pagesRendered(ctx, 10);
    await ctx.checkpoint("merged");
  },
};

export const PAGE_OP_JOURNEYS: readonly Journey[] = [J006];
