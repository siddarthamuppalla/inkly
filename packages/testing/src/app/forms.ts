import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";

import { runTool } from "../pdf/tools.ts";
import { verifyFile } from "../pdf/verify.ts";
import {
  currentVersionIs,
  openDocuments,
  pagesRendered,
  reach,
  uploadFromList,
  WAIT,
} from "./documents.ts";
import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn } from "./sign-in.ts";

interface Field {
  name: string;
  value: unknown;
}

async function clearDropdown(ctx: JourneyContext) {
  const doc = await PDFDocument.create();
  const country = doc.getForm().createDropdown("country");
  country.addOptions(["France", "Japan"]);
  country.select("Japan");
  country.addToPage(doc.addPage(), { x: 40, y: 500, width: 180, height: 25 });
  await openDocuments(ctx);
  await ctx.page.getByTestId("upload-input").setInputFiles({
    name: "choice-form.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(await doc.save()),
  });
  const row = ctx.page.getByTestId("document-row").filter({ hasText: "choice-form" });
  await row.waitFor(WAIT);
  await row.getByRole("link", { name: "choice-form" }).click();
  await pagesRendered(ctx, 1);
  const select = ctx.page.getByLabel("Country", { exact: true });
  await select.selectOption("");
  ctx.expect((await select.inputValue()) === "", "clearing a dropdown restored its saved option");
  await ctx.checkpoint("cleared-dropdown");
  await ctx.page.getByRole("button", { name: "Save", exact: true }).click();
  await currentVersionIs(ctx, 2, 1);
  ctx.expect((await select.inputValue()) === "", "the saved dropdown is not empty");
}

/** Saves the current Version's bytes, runs verify-pdf on them and reads their form and text. */
async function savedVersion(ctx: JourneyContext, token: string, id: string, n: number) {
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const api = (path: string) => new URL(`/api/documents/${id}${path}`, ctx.baseUrl).toString();
  const form = (await (await ctx.page.request.get(api("/form"), auth)).json()) as {
    fields?: Field[];
  };
  const file = join(ctx.outDir, `J-009-v${String(n)}.pdf`);
  writeFileSync(file, await (await ctx.page.request.get(api("/content"), auth)).body());
  const verified = verifyFile(file, { expectPages: 1 });
  ctx.expect(verified.ok, `verify-pdf on v${String(n)}: ${verified.failures.join("; ")}`);
  return {
    values: Object.fromEntries((form.fields ?? []).map((f) => [f.name, f.value])),
    hasForm: verified.info?.form ?? false,
    text: runTool("pdftotext", [file, "-"]).stdout,
  };
}

export const J009: Journey = {
  id: "J-009",
  title: "Fill a PDF form, save it as a new Version, then flatten it",
  async run(ctx) {
    const { page, expect } = ctx;
    const who = await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "forms.pdf");
    await page.getByTestId("document-row").getByRole("link", { name: "forms" }).click();
    await pagesRendered(ctx, 1);
    const panel = page.getByRole("heading", { name: "Fill form" });
    await reach(ctx, panel.waitFor(WAIT), "the viewer shows no Fill form panel for forms.pdf");
    await ctx.checkpoint("form");

    await page.getByLabel("Full name", { exact: true }).fill("Ada Lovelace");
    await page.getByLabel("Email", { exact: true }).fill("ada@example.test");
    await page.getByLabel("Agree", { exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await reach(
      ctx,
      page.getByRole("status").getByText("Saved as version 2.").waitFor(WAIT),
      "Save did not report version 2",
    );
    await currentVersionIs(ctx, 2, 1);
    expect(
      (await page.getByLabel("Full name", { exact: true }).inputValue()) === "Ada Lovelace",
      "the panel does not show the saved name for version 2",
    );
    await ctx.checkpoint("saved");

    const id = new URL(page.url()).pathname.split("/").pop() ?? "";
    const v2 = await savedVersion(ctx, who.token, id, 2);
    expect(
      JSON.stringify(v2.values) ===
        JSON.stringify({ full_name: "Ada Lovelace", email: "ada@example.test", agree: true }),
      `version 2 form values are ${JSON.stringify(v2.values)}`,
    );
    expect(v2.hasForm, "version 2 lost its form");

    await page.getByLabel("Flatten", { exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await currentVersionIs(ctx, 3, 1);
    await reach(
      ctx,
      panel.waitFor({ ...WAIT, state: "detached" }),
      "the Fill form panel is still shown after flattening",
    );
    await ctx.checkpoint("flattened");

    const v3 = await savedVersion(ctx, who.token, id, 3);
    expect(
      Object.keys(v3.values).length === 0,
      `version 3 still has fields: ${JSON.stringify(v3.values)}`,
    );
    expect(!v3.hasForm, "pdfinfo still reports a form on version 3");
    expect(v3.text.includes("Ada Lovelace"), "version 3's page text lacks the flattened name");
    await clearDropdown(ctx);
  },
};
