import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator } from "playwright";

import { fixture, openDocuments, pagesRendered, reach, uploadFromList, WAIT } from "./documents.ts";
import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn } from "./sign-in.ts";

// J-016 drives the T3.2 Envelope editor and status page; every /api/envelopes route is
// reached from the page, so --all route coverage sees them.

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SIGN_LINK = /\/sign\/([A-Za-z0-9_-]{43})\b/g;
const ENVELOPE_PATH = /^\/envelopes\/env_[a-f0-9]{32}$/;

async function signLinks(ctx: JourneyContext, to: string): Promise<string[]> {
  const url = new URL("/__test/outbox", ctx.baseUrl);
  url.searchParams.set("to", to);
  const res = await ctx.page.request.get(url.toString(), {
    headers: { "x-test-hooks-secret": ctx.secret ?? "" },
  });
  const body = (await res.json().catch(() => ({}))) as { messages?: { text: string }[] };
  return (body.messages ?? []).flatMap((m) =>
    [...m.text.matchAll(SIGN_LINK)].map((x) => x[1] ?? ""),
  );
}

const email = (label: string) =>
  `j016-${label}-${Math.random().toString(36).slice(2, 10)}@verify.inkly.test`;

/** From the open Document: Send for signature, then wait for the draft editor. */
async function newDraft(ctx: JourneyContext): Promise<string> {
  const { page } = ctx;
  await page.getByRole("button", { name: "Send for signature" }).click();
  await reach(
    ctx,
    page.waitForURL((u) => ENVELOPE_PATH.test(u.pathname), WAIT),
    "Send for signature did not open /envelopes/:id",
  );
  await reach(ctx, page.getByTestId("save-state").waitFor(WAIT), "the draft editor did not open");
  return new URL(page.url()).pathname;
}

async function addRecipient(
  ctx: JourneyContext,
  name: string,
  address: string,
  role: "signer" | "cc" = "signer",
) {
  const { page } = ctx;
  await page.getByRole("button", { name: "Add recipient" }).click();
  const row = page.getByTestId("recipient").last();
  await row.getByLabel("Name").fill(name);
  await row.getByLabel("Email").fill(address);
  if (role === "cc") await row.getByLabel("Role").selectOption("cc");
}

const layer = (ctx: JourneyContext, n: number) =>
  ctx.page.locator(`[data-testid="field-layer"][data-page="${String(n)}"]`);

/** Where (fx, fy), as shares of page `n`'s width and height, falls in its layer, in px. */
async function spot(ctx: JourneyContext, n: number, fx: number, fy: number) {
  const target = layer(ctx, n);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  return { x: (box?.width ?? 0) * fx, y: (box?.height ?? 0) * fy };
}

/** Picks a field type from the palette and clicks it onto page `n` at (fx, fy) of the page. */
async function place(ctx: JourneyContext, kind: string, n: number, fx: number, fy: number) {
  await ctx.page
    .getByRole("group", { name: "Field types" })
    .getByRole("button", { name: kind })
    .click();
  await layer(ctx, n).click({ position: await spot(ctx, n, fx, fy) });
}

/** Drags a field type from the palette onto page `n` with the mouse, as a sender would. */
async function dragOnto(ctx: JourneyContext, kind: string, n: number, fx: number, fy: number) {
  const { page } = ctx;
  const at = await spot(ctx, n, fx, fy);
  const target = await layer(ctx, n).boundingBox();
  const source = await page
    .getByRole("group", { name: "Field types" })
    .getByRole("button", { name: kind })
    .boundingBox();
  const viewport = page.viewportSize();
  ctx.expect(
    source !== null && source.y >= 0 && source.y + source.height <= (viewport?.height ?? 0),
    `the palette is out of view (y ${String(source?.y)}) while page ${String(n)} is on screen`,
  );
  if (!source || !target) return;
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + at.x, target.y + at.y, { steps: 10 });
  await page.mouse.up();
}

async function fieldsFor(ctx: JourneyContext, name: string) {
  await ctx.page.getByLabel("Fields for").selectOption({ label: name });
}

async function saved(ctx: JourneyContext, what: string) {
  await reach(
    ctx,
    ctx.page
      .getByTestId("save-state")
      .filter({ hasText: /^Saved$/ })
      .waitFor(WAIT),
    `the draft did not save ${what}`,
  );
}

const leftOf = (field: Locator) =>
  field.evaluate((el) => (el as { style: { left: string } }).style.left);

const J016: Journey = {
  id: "J-016",
  title: "Place fields and send an Envelope",
  async run(ctx) {
    const { page, baseUrl, expect } = ctx;
    await signedIn(ctx);
    await openDocuments(ctx);
    await uploadFromList(ctx, "10p.pdf");
    await page.getByTestId("document-row").getByRole("link", { name: "10p" }).click();
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "10p" }).waitFor(WAIT),
      "the viewer did not open",
    );
    const documentPath = new URL(page.url()).pathname;

    const path = await newDraft(ctx);
    const ana = email("ana");
    await page.getByLabel("Title").fill("J-016 lease");
    await addRecipient(ctx, "Ana Ruiz", ana);
    await addRecipient(ctx, "Ben Ode", email("ben"));
    await addRecipient(ctx, "Cat Lin", email("cat"), "cc");
    await page.getByLabel("Sequential").check();
    await pagesRendered(ctx, 10);

    await fieldsFor(ctx, "Ana Ruiz");
    await place(ctx, "Signature", 1, 0.3, 0.8);
    await fieldsFor(ctx, "Ben Ode");
    await dragOnto(ctx, "Initials", 2, 0.5, 0.8);
    await place(ctx, "Date", 2, 0.75, 0.8);
    await place(ctx, "Text", 1, 0.5, 0.3);

    const fields = page.getByTestId("envelope-field");
    await reach(ctx, fields.nth(3).waitFor(WAIT), "four placed fields are not on the pages");
    const kinds = (await fields.evaluateAll((els) =>
      els.map((el) => (el as unknown as { dataset: { kind: string } }).dataset.kind),
    )) as string[];
    expect(
      [...kinds].sort().join(",") === "date,initials,signature,text",
      `placed fields are ${kinds.join(",")}`,
    );
    expect(
      (await page.getByRole("button", { name: "Initials for Ben Ode, page 2" }).count()) === 1,
      "the dragged initials field is not Ben Ode's on page 2",
    );

    const text = page.locator('[data-testid="envelope-field"][data-kind="text"]');
    const focusedKind = await page
      .locator(":focus")
      .getAttribute("data-kind")
      .catch(() => null);
    expect(focusedKind === "text", `after placing, focus is on ${String(focusedKind)}`);
    const before = await leftOf(text);
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("ArrowDown");
    const moved = await leftOf(text);
    expect(
      Math.abs(parseFloat(moved) - parseFloat(before) - 10) < 0.01,
      `Shift+ArrowRight twice moved the text field from ${before} to ${moved}, expected +10%`,
    );

    const problem = page.getByTestId("send-problem");
    await reach(
      ctx,
      problem.filter({ hasText: "Ben Ode has no signature field" }).waitFor(WAIT),
      `the editor does not name Ben's missing signature (it says "${(await problem.textContent()) ?? ""}")`,
    );
    const send = page.getByRole("button", { name: "Send", exact: true });
    expect(await send.isDisabled(), "Send is enabled with a signer lacking a signature field");
    await saved(ctx, "after placing fields");
    await ctx.checkpoint("editor");

    await page.reload();
    await pagesRendered(ctx, 10);
    await reach(ctx, fields.nth(3).waitFor(WAIT), "the fields did not survive a reload");
    expect((await fields.count()) === 4, `after reload ${String(await fields.count())} fields`);
    expect((await leftOf(text)) === moved, "the arrow-key move did not survive a reload");
    expect(
      (await page.getByTestId("recipient").count()) === 3 &&
        (await page.getByLabel("Sequential").isChecked()),
      "recipients or the sequential order did not survive a reload",
    );

    await fieldsFor(ctx, "Ben Ode");
    await place(ctx, "Signature", 2, 0.3, 0.9);
    await reach(
      ctx,
      problem.filter({ hasText: "Ready to send." }).waitFor(WAIT),
      "the editor does not say the draft is ready",
    );
    await saved(ctx, "before send");
    await send.click();

    await reach(
      ctx,
      page.getByTestId("envelope-status").filter({ hasText: "Sent" }).waitFor(WAIT),
      "Send did not turn the page into the status page",
    );
    expect(
      (await page.getByTestId("status-recipient").count()) === 3,
      "the status page does not list three recipients",
    );
    await reach(
      ctx,
      page.getByTestId("audit-verified").waitFor(WAIT),
      'the status page does not show "Audit trail verified"',
    );
    const [first] = await signLinks(ctx, ana);
    expect(first?.length === 43, "Ana's email has no /sign/{43-char token} link");
    await ctx.checkpoint("status");

    await page.getByRole("button", { name: "Remind" }).click();
    await reach(
      ctx,
      page.getByTestId("remind-result").filter({ hasText: "1 signer" }).waitFor(WAIT),
      "Remind did not report a reminder to 1 signer",
    );
    const links = await signLinks(ctx, ana);
    expect(
      links.length === 2 && links[0] !== links[1],
      `after Remind Ana has ${String(links.length)} distinct links, expected 2`,
    );

    const [download] = await Promise.all([
      page.waitForEvent("download", WAIT),
      page.getByRole("button", { name: "Download PDF" }).click(),
    ]);
    const file = join(ctx.outDir, "J-016-envelope.pdf");
    await download.saveAs(file);
    expect(
      sha256(readFileSync(file)) === sha256(readFileSync(fixture("10p.pdf"))),
      "the Envelope download is not the pinned Version's bytes",
    );

    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    expect(overflow <= 0, `the status page scrolls sideways by ${String(overflow)}px at 320px`);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(new URL("/envelopes", baseUrl).toString());
    await page.getByLabel("Show").selectOption("sent");
    await reach(
      ctx,
      page
        .getByTestId("envelope-row")
        .filter({ hasText: "J-016 lease" })
        .filter({ hasText: "Sent" })
        .waitFor(WAIT),
      "/envelopes filtered to Sent does not list J-016 lease",
    );

    // A second Envelope, sent and then voided from its status page.
    await page.goto(new URL(documentPath, baseUrl).toString());
    const second = await newDraft(ctx);
    expect(second !== path, "the second draft reused the first Envelope");
    await page.getByLabel("Title").fill("J-016 void me");
    await addRecipient(ctx, "Dee Park", email("dee"));
    await pagesRendered(ctx, 10);
    await place(ctx, "Signature", 1, 0.3, 0.8);
    await reach(
      ctx,
      problem.filter({ hasText: "Ready to send." }).waitFor(WAIT),
      "draft 2 is not ready",
    );
    await saved(ctx, "draft 2");
    await send.click();
    await page.getByRole("button", { name: "Void", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Void this envelope?" });
    await reach(ctx, dialog.waitFor(WAIT), "Void did not open its dialog");
    expect(
      (await dialog.locator("input:focus").count()) === 1,
      "the Void dialog did not move focus to the reason field",
    );
    await dialog.getByLabel("Reason").fill("Wrong tenant on the lease");
    await dialog.getByRole("button", { name: "Void envelope" }).click();
    await reach(
      ctx,
      page.getByTestId("envelope-status").filter({ hasText: "Voided" }).waitFor(WAIT),
      "the voided Envelope does not say Voided",
    );
    await reach(
      ctx,
      page
        .getByTestId("audit-events")
        .filter({ hasText: "Wrong tenant on the lease" })
        .waitFor(WAIT),
      "the audit trail does not show the void reason",
    );

    // A third draft, deleted.
    await page.goto(new URL(documentPath, baseUrl).toString());
    await newDraft(ctx);
    await page.getByRole("button", { name: "Delete draft" }).click();
    await page
      .getByRole("dialog", { name: "Delete this draft?" })
      .getByRole("button", { name: "Delete draft" })
      .click();
    await reach(
      ctx,
      page.waitForURL((u) => u.pathname === "/envelopes", WAIT),
      "deleting the draft did not return to /envelopes",
    );
    await reach(
      ctx,
      page.getByTestId("envelope-row").nth(1).waitFor(WAIT),
      "/envelopes did not list",
    );
    expect(
      (await page.getByTestId("envelope-row").count()) === 2,
      `after deleting a draft /envelopes lists ${String(await page.getByTestId("envelope-row").count())} envelopes, expected 2`,
    );
    await ctx.checkpoint("list");
  },
};

export const ENVELOPE_JOURNEYS: readonly Journey[] = [J016];
