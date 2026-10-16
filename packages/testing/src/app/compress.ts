import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn } from "./sign-in.ts";

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/pdfs/huge-image.pdf");
const WAIT = { timeout: 20_000 };
// A preview's first Job cold-starts the Container.
const JOB_WAIT = { timeout: 180_000 };

async function reach(ctx: JourneyContext, wait: Promise<unknown>, message: string) {
  const ok = await wait.then(
    () => true,
    () => false,
  );
  ctx.expect(ok, message);
  return ok;
}

const J007: Journey = {
  id: "J-007",
  title: "Compress a PDF through pdf-engine",
  async run(ctx) {
    const { page, expect } = ctx;
    const who = await signedIn(ctx);
    const original = readFileSync(FIXTURE);
    await page.goto(new URL("/", ctx.baseUrl).toString());
    await reach(
      ctx,
      page.getByRole("button", { name: "Upload PDF" }).waitFor(WAIT),
      "the Documents page did not offer Upload PDF",
    );
    await page.getByTestId("upload-input").setInputFiles(FIXTURE);
    const row = page.getByTestId("document-row").filter({ hasText: "huge-image" });
    await reach(ctx, row.waitFor(WAIT), "huge-image.pdf did not appear after upload");
    await row.getByRole("link", { name: "huge-image" }).click();
    await reach(
      ctx,
      page.locator('[data-testid="page"][data-rendered="true"]').first().waitFor(WAIT),
      "the viewer did not render the page",
    );

    await page.getByLabel("Quality").selectOption("screen");
    await page.getByRole("button", { name: "Compress", exact: true }).click();
    const status = page.getByTestId("compress-status");
    await reach(
      ctx,
      status.getByText(/Waiting to compress|Compressing|Compressed into/).waitFor(WAIT),
      "Compress did not show the Job's status",
    );
    const done = await reach(
      ctx,
      status.getByText(/Compressed into version 2/).waitFor(JOB_WAIT),
      `the Job did not finish with version 2 (status reads "${(await status.textContent()) ?? ""}")`,
    );
    if (!done) return;

    const versions = page.getByTestId("version");
    await reach(ctx, versions.nth(1).waitFor(WAIT), "version history does not list v2");
    const top = (await versions.first().textContent().catch(() => "")) ?? "";
    expect(
      top.includes("Version 2") && top.includes("Current") && top.includes("1 page"),
      `the newest version reads "${top}", expected Version 2, Current, 1 page`,
    );
    await reach(
      ctx,
      page.locator('[data-testid="page"][data-rendered="true"]').first().waitFor(WAIT),
      "the viewer did not render the compressed version",
    );
    await ctx.checkpoint("compressed");

    const id = new URL(page.url()).pathname.split("/").pop() ?? "";
    const auth = { headers: { authorization: `Bearer ${who.token}` } };
    const content = await page.request.get(
      new URL(`/api/documents/${id}/content`, ctx.baseUrl).toString(),
      auth,
    );
    const bytes = await content.body();
    expect(
      bytes.subarray(0, 5).toString("latin1") === "%PDF-",
      "the compressed version is not a PDF",
    );
    expect(
      bytes.length < original.length,
      `the compressed version is ${String(bytes.length)} bytes, not smaller than ${String(original.length)}`,
    );
    const jobs = await page.request.get(
      new URL(`/api/documents/${id}/jobs`, ctx.baseUrl).toString(),
      auth,
    );
    const [job] = ((await jobs.json()) as { jobs: { status: string; output: unknown }[] }).jobs;
    expect(job?.status === "succeeded", `the Job is ${String(job?.status)}, expected succeeded`);
  },
};

export const COMPRESS_JOURNEYS: readonly Journey[] = [J007];
