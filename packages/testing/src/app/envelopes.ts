import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Journey, JourneyContext } from "./journeys.ts";
import { signedIn } from "./sign-in.ts";

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

export const ENVELOPE_JOURNEYS: readonly Journey[] = [J016];
