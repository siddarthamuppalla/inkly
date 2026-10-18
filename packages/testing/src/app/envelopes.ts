import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { reach, WAIT } from "./documents.ts";
import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn, type SeededUser } from "./sign-in.ts";

// J-016 drives the T3.1 sender API from the page (so every request counts toward route
// coverage). T3.2 replaces these steps with the field-placement UI.

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/pdfs");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SIGN_LINK = /\/sign\/([A-Za-z0-9_-]{43})\b/g;

interface Answer {
  status: number;
  body: Record<string, unknown> & {
    envelope?: { id: string; status: string };
    envelopes?: { id: string }[];
    events?: { action: string; seq: number }[];
    chain?: { valid: boolean };
  };
}

/** One JSON API call made by the page itself, with the page's bearer header. */
function api(ctx: JourneyContext, method: string, path: string, body?: unknown): Promise<Answer> {
  return ctx.page.evaluate<Answer, [string, string, string | null]>(
    async ([m, p, b]) => {
      const res = await fetch(p, {
        method: m,
        ...(b === null ? {} : { headers: { "content-type": "application/json" }, body: b }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as Answer["body"]) : {} };
    },
    [method, path, body === undefined ? null : JSON.stringify(body)],
  );
}

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

const J016: Journey = {
  id: "J-016",
  title: "Send an Envelope (API)",
  // Reading a deleted draft is a designed 404.
  expectedClientErrors: [{ status: 404, path: /^\/api\/envelopes\/env_[a-f0-9]{32}$/ }],
  async run(ctx) {
    const { page, baseUrl, expect } = ctx;
    const who = await signedIn(ctx);
    await page.goto(new URL("/", baseUrl).toString());
    await page.getByTestId("app-shell").waitFor({ timeout: 20_000 });

    const pdf = readFileSync(join(FIXTURES, "tiny.pdf"));
    const uploaded = await page.request.post(
      new URL("/api/documents?filename=tiny.pdf", baseUrl).toString(),
      {
        headers: { authorization: `Bearer ${who.token}`, "content-type": "application/pdf" },
        data: pdf,
      },
    );
    const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;

    const created = await api(ctx, "POST", "/api/envelopes", { documentId });
    expect(created.status === 201, `POST /api/envelopes returned ${String(created.status)}`);
    const id = created.body.envelope?.id ?? "";
    const path = `/api/envelopes/${id}`;
    const signer = `j016-${Math.random().toString(36).slice(2, 10)}@verify.inkly.test`;
    const draft = await api(ctx, "PUT", path, {
      title: "J-016 lease",
      message: "Please sign",
      recipients: [{ id: "rcp_signer1", name: "Ana Ruiz", email: signer, role: "signer" }],
      fields: [
        {
          recipientId: "rcp_signer1",
          kind: "signature",
          page: 1,
          rect: { x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
        },
      ],
    });
    expect(draft.status === 200, `PUT ${path} returned ${String(draft.status)}`);
    const read = await api(ctx, "GET", path);
    expect(read.status === 200, `GET ${path} returned ${String(read.status)}`);

    const sent = await api(ctx, "POST", `${path}/send`);
    expect(
      sent.status === 200 && sent.body.envelope?.status === "sent",
      `send returned ${String(sent.status)} ${JSON.stringify(sent.body)}`,
    );
    const listed = await api(ctx, "GET", "/api/envelopes?status=sent");
    expect(
      (listed.body.envelopes ?? []).some((e) => e.id === id),
      "the sent Envelope is not listed under status=sent",
    );
    const [link] = await signLinks(ctx, signer);
    expect(link?.length === 43, `no /sign/{43-char token} link in the Outbox for ${signer}`);

    const audit = await api(ctx, "GET", `${path}/audit`);
    const actions = (audit.body.events ?? []).map((e) => e.action).join(",");
    expect(actions === "created,sent,notified", `audit actions are ${actions}`);
    expect(audit.body.chain?.valid === true, "the audit chain does not verify");

    const content = await page.evaluate<string, string>(
      (p) =>
        fetch(p)
          .then((r) => r.arrayBuffer())
          .then((b) => crypto.subtle.digest("SHA-256", b))
          .then((d) => [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("")),
      `${path}/content`,
    );
    expect(content === sha256(pdf), "Envelope content is not the pinned Version's bytes");

    const reminded = await api(ctx, "POST", `${path}/remind`);
    expect(reminded.status === 200, `remind returned ${String(reminded.status)}`);
    const links = await signLinks(ctx, signer);
    expect(
      links.length === 2 && links[0] !== links[1],
      `after remind the Outbox has ${String(links.length)} distinct-link emails, expected 2`,
    );
    const voided = await api(ctx, "POST", `${path}/void`, { reason: "J-016 is done" });
    expect(
      voided.body.envelope?.status === "voided",
      `void returned ${String(voided.status)} ${JSON.stringify(voided.body)}`,
    );

    const spare = await api(ctx, "POST", "/api/envelopes", { documentId });
    const sparePath = `/api/envelopes/${spare.body.envelope?.id ?? ""}`;
    const deleted = await api(ctx, "DELETE", sparePath);
    expect(deleted.status === 204, `DELETE ${sparePath} returned ${String(deleted.status)}`);
    const gone = await api(ctx, "GET", sparePath);
    expect(gone.status === 404, `a deleted draft returned ${String(gone.status)}`);
  },
};

// J-018 drives the T3.3 signer page as the Recipient would, signed out: decline one
// Envelope, see a voided one's link stop working, and sign a sequential one as two signers.

/** The sender's own API call, with their bearer token, after the page itself has signed out. */
async function asSender(
  ctx: JourneyContext,
  who: SeededUser,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Answer> {
  const res = await ctx.page.request.fetch(new URL(path, ctx.baseUrl).toString(), {
    method,
    headers: { authorization: `Bearer ${who.token}` },
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await res.text();
  return { status: res.status(), body: text ? (JSON.parse(text) as Answer["body"]) : {} };
}

async function mailTo(
  ctx: JourneyContext,
  to: string,
): Promise<{ subject: string; text: string }[]> {
  const url = new URL("/__test/outbox", ctx.baseUrl);
  url.searchParams.set("to", to);
  const res = await ctx.page.request.get(url.toString(), {
    headers: { "x-test-hooks-secret": ctx.secret ?? "" },
  });
  const body = (await res.json().catch(() => ({}))) as {
    messages?: { subject: string; text: string }[];
  };
  return body.messages ?? [];
}

const box = (y: number) => ({ x: 0.1, y, w: 0.35, h: 0.06 });

/** A sent Envelope of `documentId`; returns its id and each signer's address. */
async function sendEnvelope(
  ctx: JourneyContext,
  who: SeededUser,
  documentId: string,
  title: string,
  signers: {
    id: string;
    name: string;
    fields: { kind: string; y: number; required?: boolean }[];
  }[],
  orderMode: "parallel" | "sequential" = "parallel",
): Promise<{ id: string; emails: string[] }> {
  const created = await asSender(ctx, who, "POST", "/api/envelopes", { documentId });
  const id = created.body.envelope?.id ?? "";
  const emails = signers.map(
    (s) => `j018-${s.id.slice(4)}-${Math.random().toString(36).slice(2, 8)}@verify.inkly.test`,
  );
  const draft = await asSender(ctx, who, "PUT", `/api/envelopes/${id}`, {
    title,
    orderMode,
    recipients: signers.map((s, i) => ({
      id: s.id,
      name: s.name,
      email: emails[i],
      role: "signer",
      routingOrder: i + 1,
    })),
    fields: signers.flatMap((s) =>
      s.fields.map((f) => ({
        recipientId: s.id,
        kind: f.kind,
        page: 1,
        rect: box(f.y),
        required: f.required ?? true,
      })),
    ),
  });
  ctx.expect(draft.status === 200, `PUT ${title} returned ${String(draft.status)}`);
  const sent = await asSender(ctx, who, "POST", `/api/envelopes/${id}/send`);
  ctx.expect(sent.status === 200, `sending ${title} returned ${String(sent.status)}`);
  return { id, emails };
}

/** Opens the newest signing link mailed to `email` and confirms the Signing code. */
async function openAndVerify(ctx: JourneyContext, email: string, checkpoint?: string) {
  const { page, baseUrl } = ctx;
  const [token] = await signLinks(ctx, email);
  await page.goto(new URL(`/sign/${token ?? ""}`, baseUrl).toString());
  await reach(
    ctx,
    page.getByRole("button", { name: "Email me a code" }).waitFor(WAIT),
    `the signing page for ${email} did not offer "Email me a code"`,
  );
  ctx.expect(
    (await page.getByTestId("app-shell").count()) === 0,
    "the signing page shows the signed-in app shell",
  );
  if (checkpoint) await ctx.checkpoint(checkpoint);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await reach(ctx, page.getByLabel("Code").waitFor(WAIT), "the code step did not appear");
  const mail = (await mailTo(ctx, email)).find((m) => m.subject.startsWith("Your signing code"));
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1] ?? "";
  ctx.expect(code !== "", `no Signing code in the Outbox for ${email}`);
  if (checkpoint) await ctx.checkpoint(`${checkpoint}-code`);
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await reach(
    ctx,
    page.locator('[data-testid="page"][data-rendered="true"]').first().waitFor(WAIT),
    `the document did not render for ${email} after the code`,
  );
  return token ?? "";
}

/** Fills the signature field the page focuses with a typed signature through the adopt dialog. */
async function adoptTyped(ctx: JourneyContext) {
  const dialog = ctx.page.getByRole("dialog");
  await reach(ctx, dialog.waitFor(WAIT), "the adopt dialog did not open");
  await dialog.getByRole("button", { name: "Adopt and sign" }).click();
  await reach(ctx, dialog.waitFor({ ...WAIT, state: "hidden" }), "the adopt dialog stayed open");
}

const J018: Journey = {
  id: "J-018",
  title: "Decline, void, and sign in sequence (signer page)",
  // A voided link is a designed 404.
  expectedClientErrors: [{ status: 404, path: /^\/api\/sign\/[\w-]{43}$/ }],
  async run(ctx) {
    const { page, baseUrl, expect } = ctx;
    const who = await signedIn(ctx, { plan: "pro" });
    const pdf = readFileSync(join(FIXTURES, "tiny.pdf"));
    const uploaded = await page.request.post(
      new URL("/api/documents?filename=tiny.pdf", baseUrl).toString(),
      {
        headers: { authorization: `Bearer ${who.token}`, "content-type": "application/pdf" },
        data: pdf,
      },
    );
    const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;
    const sigOnly = [{ kind: "signature", y: 0.7 }];
    const declined = await sendEnvelope(ctx, who, documentId, "J-018 decline", [
      { id: "rcp_dee", name: "Dee Clyne", fields: sigOnly },
    ]);
    const voided = await sendEnvelope(ctx, who, documentId, "J-018 void", [
      { id: "rcp_vic", name: "Vic Toid", fields: sigOnly },
    ]);
    const sequence = await sendEnvelope(
      ctx,
      who,
      documentId,
      "J-018 lease",
      [
        {
          id: "rcp_ana",
          name: "Ana Ruiz",
          fields: [
            { kind: "signature", y: 0.7 },
            { kind: "date", y: 0.8 },
            { kind: "text", y: 0.5 },
            { kind: "checkbox", y: 0.3, required: false },
          ],
        },
        {
          id: "rcp_bo",
          name: "Bo Li",
          fields: [
            { kind: "signature", y: 0.6 },
            { kind: "initials", y: 0.4 },
          ],
        },
      ],
      "sequential",
    );

    // From here the page is the signer's browser: no session cookie, no bearer header.
    await page.context().clearCookies();
    await page.setExtraHTTPHeaders({});

    await openAndVerify(ctx, declined.emails[0] ?? "", "sign-intro");
    await ctx.checkpoint("sign-document");
    await page.getByRole("button", { name: "Decline to sign" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Reason").fill("The rent is wrong");
    await ctx.checkpoint("decline-dialog");
    await dialog.getByRole("button", { name: "Decline", exact: true }).click();
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "You declined to sign" }).waitFor(WAIT),
      "declining did not show the declined state",
    );
    await ctx.checkpoint("declined");
    const notice = (await mailTo(ctx, who.email)).find((m) =>
      m.subject.includes('declined to sign "J-018 decline"'),
    );
    expect(
      notice?.text.includes("Reason: The rent is wrong") === true,
      "the sender got no decline email",
    );
    const afterDecline = await asSender(ctx, who, "GET", `/api/envelopes/${declined.id}`);
    expect(
      afterDecline.body.envelope?.status === "declined",
      `the declined Envelope is ${String(afterDecline.body.envelope?.status)}`,
    );

    const voidRes = await asSender(ctx, who, "POST", `/api/envelopes/${voided.id}/void`, {
      reason: "Sent by mistake",
    });
    expect(voidRes.status === 200, `void returned ${String(voidRes.status)}`);
    const [voidToken] = await signLinks(ctx, voided.emails[0] ?? "");
    await page.goto(new URL(`/sign/${voidToken ?? ""}`, baseUrl).toString());
    await reach(
      ctx,
      page
        .getByRole("heading", { level: 1, name: "This link is no longer available" })
        .waitFor(WAIT),
      "a voided Envelope's link still opens",
    );
    await ctx.checkpoint("voided");

    const [ana, bo] = sequence.emails as [string, string];
    expect((await signLinks(ctx, bo)).length === 0, "signer 2 was emailed before signer 1 signed");
    await openAndVerify(ctx, ana);
    const finish = page.getByRole("button", { name: "Finish" });
    expect(await finish.isDisabled(), "Finish is enabled before the fields are filled");
    await page.getByRole("button", { name: "Next field" }).click();
    expect(
      (await page.locator(":focus").getAttribute("data-kind")) === "text",
      "Next field did not go to the text field first (page order)",
    );
    await page.keyboard.type("Apt 4B");
    await page.getByRole("button", { name: "Next field" }).click();
    expect(
      (await page.locator(":focus").getAttribute("data-kind")) === "signature",
      "Next field did not go to the signature field next",
    );
    await page.keyboard.press("Enter");
    await ctx.checkpoint("adopt-type");
    await adoptTyped(ctx);
    expect(
      await page
        .getByRole("button", { name: /^Signature, page 1 \(required\): signed/ })
        .isVisible(),
      "the signature field does not show as signed",
    );
    await page.getByLabel(/^I agree to use electronic records/).check();
    await ctx.checkpoint("ready");
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    expect(overflow <= 0, `/sign scrolls horizontally by ${String(overflow)}px at 320px wide`);
    await ctx.checkpoint("ready-320");
    await page.setViewportSize({ width: 1280, height: 800 });
    await finish.click();
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "You signed" }).waitFor(WAIT),
      "Finish did not show the signed state",
    );
    await ctx.checkpoint("signed");

    expect(
      (await signLinks(ctx, bo)).length === 1,
      "signer 2 was not emailed after signer 1 signed",
    );
    await openAndVerify(ctx, bo);
    await page.getByRole("button", { name: /^Initials/ }).click();
    await adoptTyped(ctx);
    await page.getByRole("button", { name: /^Signature/ }).click();
    const dialogB = page.getByRole("dialog");
    await dialogB.getByRole("button", { name: "Draw" }).click();
    const pad = dialogB.getByTestId("signature-pad");
    const area = await pad.boundingBox();
    if (area) {
      await page.mouse.move(area.x + 20, area.y + area.height / 2);
      await page.mouse.down();
      await page.mouse.move(area.x + area.width / 2, area.y + 15, { steps: 8 });
      await page.mouse.move(area.x + area.width - 20, area.y + area.height - 15, { steps: 8 });
      await page.mouse.up();
    }
    await ctx.checkpoint("adopt-draw");
    await dialogB.getByRole("button", { name: "Adopt and sign" }).click();
    await page.getByLabel(/^I agree to use electronic records/).check();
    await page.getByRole("button", { name: "Finish" }).click();
    await reach(
      ctx,
      page.getByRole("heading", { level: 1, name: "You signed" }).waitFor(WAIT),
      "signer 2's Finish did not show the signed state",
    );

    const done = await asSender(ctx, who, "GET", `/api/envelopes/${sequence.id}`);
    expect(
      done.body.envelope?.status === "completing",
      `after both signed the Envelope is ${String(done.body.envelope?.status)}`,
    );
    const audit = await asSender(ctx, who, "GET", `/api/envelopes/${sequence.id}/audit`);
    const actions = (audit.body.events ?? []).map((e) => e.action);
    expect(
      actions.join(",") ===
        "created,sent,notified,code_sent,verified,viewed,signed,notified,code_sent,verified,viewed,signed",
      `audit actions are ${actions.join(",")}`,
    );
    expect(audit.body.chain?.valid === true, "the audit chain does not verify");
  },
};

export const ENVELOPE_JOURNEYS: readonly Journey[] = [J016, J018];
