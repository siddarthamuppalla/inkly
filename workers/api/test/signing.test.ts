import {
  CONSENT_TEXT,
  signingDate,
  verifyChain,
  type AuditEvent,
  type DocumentInfo,
  type EnvelopeInfo,
  type FieldInfo,
  type RecipientInfo,
  type SignerEnvelope,
} from "@inkly/domain";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import app from "../src/index.ts";
import { rows } from "./d1.ts";
import {
  accessLog,
  as,
  fixture,
  hooks,
  json,
  ORIGIN,
  outbox,
  seed,
  sha256,
  uniqueEmail,
  uploaded,
  type Seeded,
} from "./helpers.ts";

interface Detail {
  envelope: EnvelopeInfo;
  recipients: RecipientInfo[];
  fields: FieldInfo[];
}

const SIGNER = { "cf-connecting-ip": "192.0.2.44", "user-agent": "SignerBrowser/3.1" };
const SIGN_LINK = /\/sign\/([A-Za-z0-9_-]{43})\b/;
const GONE = { error: "not_found", message: "This link is no longer available" };
/** A 1×1 PNG, as the signer page sends it. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function person(label: string, routingOrder = 1) {
  return {
    id: `rcp_${label}${crypto.randomUUID().slice(0, 8)}`,
    name: `${label[0]?.toUpperCase() ?? ""}${label.slice(1)} Tester`,
    email: uniqueEmail(label),
    role: "signer" as const,
    routingOrder,
  };
}
type Person = ReturnType<typeof person>;

const rect = (y: number) => ({ x: 0.1, y, w: 0.3, h: 0.05 });

/** The fields each signer gets unless a test says otherwise: a signature, a date and a text box. */
function fieldsFor(p: Person) {
  return [
    { recipientId: p.id, kind: "signature", page: 1, rect: rect(0.8) },
    { recipientId: p.id, kind: "date", page: 1, rect: rect(0.7) },
    { recipientId: p.id, kind: "text", page: 1, rect: rect(0.6), required: false },
  ];
}

/** A sent Envelope of `doc` to `signers`, as `owner`. */
async function sent(
  owner: Seeded,
  doc: DocumentInfo,
  signers: Person[],
  extra: Record<string, unknown> = {},
): Promise<Detail> {
  const created = await as(owner, "/api/envelopes", json("POST", { documentId: doc.id }));
  const { envelope } = await created.json<Detail>();
  const put = await as(
    owner,
    `/api/envelopes/${envelope.id}`,
    json("PUT", {
      title: "Lease",
      recipients: signers,
      fields: signers.flatMap(fieldsFor),
      ...extra,
    }),
  );
  if (put.status !== 200) throw new Error(`PUT returned ${String(put.status)}`);
  const res = await as(owner, `/api/envelopes/${envelope.id}/send`, { method: "POST" });
  if (res.status !== 200) throw new Error(`send returned ${String(res.status)}`);
  return res.json<Detail>();
}

async function linkOf(email: string): Promise<string> {
  const mail = await outbox(email);
  const token = mail.flatMap((m) => SIGN_LINK.exec(m.text)?.[1] ?? [])[0];
  if (!token) throw new Error(`no signing link for ${email}`);
  return token;
}

async function codeOf(email: string): Promise<string> {
  const mail = (await outbox(email)).find((m) => m.subject.startsWith("Your signing code"));
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no signing code for ${email}`);
  return code;
}

/** A signed-out request from the signer's browser. */
function visit(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(SIGNER)) headers.set(k, v);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  return Promise.resolve(app.request(`${ORIGIN}${path}`, { ...init, headers }, hooks));
}

const post = (path: string, body: unknown = {}, cookie = "") =>
  visit(path, { method: "POST", body: JSON.stringify(body), headers: { cookie } });

/** Asks for a code, enters it and returns the grant cookie. */
async function verify(token: string, email: string): Promise<string> {
  expect((await post(`/api/sign/${token}/code`)).status).toBe(204);
  const res = await post(`/api/sign/${token}/verify`, { code: await codeOf(email) });
  expect(res.status).toBe(204);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function info(token: string, cookie = ""): Promise<SignerEnvelope> {
  return (await visit(`/api/sign/${token}`, { headers: { cookie } })).json<SignerEnvelope>();
}

async function trail(owner: Seeded, id: string): Promise<AuditEvent[]> {
  const res = await as(owner, `/api/envelopes/${id}/audit`);
  const body = await res.json<{ events: AuditEvent[]; chain: { valid: boolean } }>();
  expect(body.chain.valid).toBe(true);
  return body.events;
}

async function detail(owner: Seeded, id: string): Promise<Detail> {
  return (await as(owner, `/api/envelopes/${id}`)).json<Detail>();
}

/** Signs every field of the signer's own: signature, a typed text value; dates fill themselves. */
async function signAll(token: string, cookie: string, fields: { id: string; kind: string }[]) {
  const values = Object.fromEntries(
    fields.flatMap((f) =>
      f.kind === "signature" ? [[f.id, PNG]] : f.kind === "text" ? [[f.id, "Apt 4B"]] : [],
    ),
  );
  return post(`/api/sign/${token}/sign`, { values, consent: true }, cookie);
}

describe("opening a signer link", () => {
  it("shows the title and sender, and refuses the document until the code is entered", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope } = await sent(owner, doc, [ana]);
    const token = await linkOf(ana.email);

    const res = await visit(`/api/sign/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({
      status: "pending",
      title: "Lease",
      message: "",
      sender: { name: expect.stringMatching(/^Seed /) as string, email: owner.email },
      recipient: { name: ana.name },
      verified: false,
      pages: null,
      fields: [],
    });
    const content = await visit(`/api/sign/${token}/content`);
    expect(content.status).toBe(401);

    const log = (await accessLog(owner.tenantId)).filter((e) => e.resource.includes(envelope.id));
    expect(log.map((e) => [e.action, e.status])).toEqual([
      ["read", 200],
      ["read-content", 401],
    ]);
    expect(log[0]).toMatchObject({ ip: SIGNER["cf-connecting-ip"], shareLinkId: null });
    const actors = await rows<{ actor_user_id: string; document_id: string }>(
      "SELECT actor_user_id, document_id FROM access_log WHERE tenant_id = ?1 AND resource LIKE ?2",
      owner.tenantId,
      `%${envelope.id}%`,
    );
    expect(actors.every((a) => a.actor_user_id === ana.id && a.document_id === doc.id)).toBe(true);
  });
});

describe("the Signing code", () => {
  it("emails 6 digits valid for 10 minutes, and a 6th send within 10 minutes is 429", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope } = await sent(owner, doc, [ana]);
    const token = await linkOf(ana.email);

    const before = Date.now();
    expect((await post(`/api/sign/${token}/code`)).status).toBe(204);
    expect(await codeOf(ana.email)).toMatch(/^\d{6}$/);
    const [stored] = await rows<{ code_hash: string; code_expires_at: number }>(
      "SELECT code_hash, code_expires_at FROM recipients WHERE envelope_id = ?1",
      envelope.id,
    );
    expect(stored?.code_hash).not.toContain(await codeOf(ana.email));
    expect(stored?.code_expires_at).toBeGreaterThanOrEqual(before + 10 * 60 * 1000);
    expect(stored?.code_expires_at).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);

    for (let i = 2; i <= 5; i++) expect((await post(`/api/sign/${token}/code`)).status).toBe(204);
    const sixth = await post(`/api/sign/${token}/code`);
    expect(sixth.status).toBe(429);
    const events = await trail(owner, envelope.id);
    expect(events.filter((e) => e.action === "code_sent")).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({ actor: ana.id, detail: { email: ana.email } });
    const log = await accessLog(owner.tenantId);
    expect(log.filter((e) => e.status === 429)).toHaveLength(1);
  });

  it("invalidates the code after 5 wrong tries", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    await sent(owner, doc, [ana]);
    const token = await linkOf(ana.email);
    await post(`/api/sign/${token}/code`);
    const code = await codeOf(ana.email);
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 1; i <= 4; i++) {
      const res = await post(`/api/sign/${token}/verify`, { code: wrong });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    const fifth = await post(`/api/sign/${token}/verify`, { code: wrong });
    expect(await fifth.json()).toMatchObject({
      message: "Too many wrong codes. Ask for a new one.",
    });
    const late = await post(`/api/sign/${token}/verify`, { code });
    expect(late.status).toBe(401);
    expect(late.headers.get("set-cookie")).toBeNull();
    expect((await post(`/api/sign/${token}/verify`, { code: "12" })).status).toBe(422);
  });

  it("sets a 1-hour grant for this link and audits verified with IP and user agent", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope } = await sent(owner, doc, [ana]);
    const token = await linkOf(ana.email);
    await post(`/api/sign/${token}/code`);
    const res = await post(`/api/sign/${token}/verify`, { code: await codeOf(ana.email) });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^inkly_sign=/);
    expect(setCookie).toContain(`Path=/api/sign/${token}`);
    expect(setCookie).toContain("Max-Age=3600");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    const verified = (await trail(owner, envelope.id)).find((e) => e.action === "verified");
    expect(verified).toMatchObject({
      actor: ana.id,
      ip: SIGNER["cf-connecting-ip"],
      userAgent: SIGNER["user-agent"],
      detail: { recipientId: ana.id, email: ana.email, method: "email_code" },
    });
    const [stored] = await rows<{ verified_ip: string; verified_user_agent: string }>(
      "SELECT verified_ip, verified_user_agent FROM recipients WHERE envelope_id = ?1",
      envelope.id,
    );
    expect(stored).toEqual({
      verified_ip: SIGNER["cf-connecting-ip"],
      verified_user_agent: SIGNER["user-agent"],
    });

    const cookie = setCookie.split(";")[0] ?? "";
    const reused = await post(`/api/sign/${token}/verify`, { code: await codeOf(ana.email) });
    expect(reused.status).toBe(401);
    const forged = cookie.replace(/=(\d+)\./, (_, exp: string) => `=${String(Number(exp) + 1)}.`);
    expect(
      (await visit(`/api/sign/${token}/content`, { headers: { cookie: forged } })).status,
    ).toBe(401);
  });
});

describe("a verified signer", () => {
  it("gets the pinned Version and only their own fields, and the first open audits viewed", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const [ana, bo] = [person("ana"), person("bo")];
    const { envelope, fields } = await sent(owner, doc, [ana, bo]);
    const token = await linkOf(ana.email);
    const cookie = await verify(token, ana.email);

    const pending = await info(token, cookie);
    expect(pending).toMatchObject({ status: "pending", verified: true, pages: 10 });
    const own = fields.filter((f) => f.recipientId === ana.id).map((f) => f.id);
    expect(pending.status === "pending" && pending.fields.map((f) => f.id)).toEqual(own);
    expect(JSON.stringify(pending)).not.toContain(bo.id);

    for (let i = 0; i < 2; i++) {
      const res = await visit(`/api/sign/${token}/content`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await sha256(await res.arrayBuffer())).toBe(doc.sha256);
    }
    const events = await trail(owner, envelope.id);
    expect(events.filter((e) => e.action === "viewed").map((e) => e.actor)).toEqual([ana.id]);
    const after = await detail(owner, envelope.id);
    expect(after.recipients.find((r) => r.id === ana.id)?.status).toBe("viewed");
  });

  it("signs their own fields: the date is the server's, consent is audited, and the link then shows done", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope, fields } = await sent(owner, doc, [ana]);
    const token = await linkOf(ana.email);
    const cookie = await verify(token, ana.email);

    const res = await signAll(token, cookie, fields);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "signed" });

    const after = await detail(owner, envelope.id);
    expect(after.recipients[0]).toMatchObject({ status: "signed" });
    expect(after.recipients[0]?.signedAt).not.toBeNull();
    expect(after.fields.map((f) => [f.kind, f.value])).toEqual([
      ["text", "Apt 4B"],
      ["date", signingDate(Date.now())],
      ["signature", PNG],
    ]);
    const signed = (await trail(owner, envelope.id)).find((e) => e.action === "signed");
    expect(signed).toMatchObject({
      actor: ana.id,
      ip: SIGNER["cf-connecting-ip"],
      detail: { recipientId: ana.id, consent: CONSENT_TEXT },
    });
    expect(JSON.stringify(signed?.detail)).not.toContain(PNG);

    expect(await info(token)).toEqual({
      status: "signed",
      title: "Lease",
      role: "signer",
      signedAvailable: false,
    });
    expect(
      await (await visit(`/api/sign/${token}/content`, { headers: { cookie } })).json(),
    ).toEqual(GONE);
    expect((await signAll(token, cookie, fields)).status).toBe(404);
    expect(after.envelope.status).toBe("completing");
  });

  it("refuses (422, logged) another recipient's field, a missing required field, a bad image or no consent", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const [ana, bo] = [person("ana"), person("bo")];
    const { envelope, fields } = await sent(owner, doc, [ana, bo]);
    const token = await linkOf(ana.email);
    const cookie = await verify(token, ana.email);
    const mine = fields.filter((f) => f.recipientId === ana.id);
    const signatureId = mine.find((f) => f.kind === "signature")?.id ?? "";
    const theirs = fields.find((f) => f.recipientId === bo.id && f.kind === "signature")?.id ?? "";

    const cases: [unknown, string][] = [
      [
        { values: { [signatureId]: PNG, [theirs]: PNG }, consent: true },
        "That field belongs to another recipient",
      ],
      [{ values: {}, consent: true }, "Fill in every required field before you finish"],
      [
        { values: { [signatureId]: "data:image/png;base64,AAAA" }, consent: true },
        "The signature must be a PNG image",
      ],
      [
        { values: { [signatureId]: PNG }, consent: false },
        "Tick the box to agree to sign electronically",
      ],
    ];
    for (const [body, message] of cases) {
      const res = await post(`/api/sign/${token}/sign`, body, cookie);
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "invalid_input", message });
    }
    const after = await detail(owner, envelope.id);
    expect(after.fields.every((f) => f.value === null)).toBe(true);
    expect(after.recipients.map((r) => r.status)).toEqual(["sent", "sent"]);
    const writes = (await accessLog(owner.tenantId)).filter((e) => e.action === "write");
    expect(writes.map((e) => e.status)).toEqual([422, 422, 422, 422]);
    expect((await trail(owner, envelope.id)).some((e) => e.action === "signed")).toBe(false);
  });

  it("can't sign or decline without the grant", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { fields } = await sent(owner, doc, [ana]);
    const token = await linkOf(ana.email);
    expect((await signAll(token, "", fields)).status).toBe(401);
    expect((await post(`/api/sign/${token}/decline`, { reason: "no" })).status).toBe(401);
  });
});

describe("routing", () => {
  it("in sequential order notifies signer 2 only after signer 1 signs, then completes after both", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const [first, second] = [person("ana", 1), person("bo", 2)];
    const { envelope, fields } = await sent(owner, doc, [first, second], {
      orderMode: "sequential",
    });
    expect(await outbox(second.email)).toEqual([]);

    const t1 = await linkOf(first.email);
    const c1 = await verify(t1, first.email);
    expect((await outbox(second.email)).length).toBe(0);
    expect(
      (
        await signAll(
          t1,
          c1,
          fields.filter((f) => f.recipientId === first.id),
        )
      ).status,
    ).toBe(200);
    const t2 = await linkOf(second.email);
    const mid = await detail(owner, envelope.id);
    expect(mid.envelope.status).toBe("sent");
    expect(mid.recipients.map((r) => r.status)).toEqual(["signed", "sent"]);
    const events = await trail(owner, envelope.id);
    const signedAt = events.findIndex((e) => e.action === "signed");
    expect(events[signedAt + 1]).toMatchObject({
      action: "notified",
      detail: { recipientId: second.id, email: second.email },
    });

    const c2 = await verify(t2, second.email);
    expect(
      (
        await signAll(
          t2,
          c2,
          fields.filter((f) => f.recipientId === second.id),
        )
      ).status,
    ).toBe(200);
    const done = await detail(owner, envelope.id);
    expect(done.envelope.status).toBe("completing");
    expect(verifyChain(await trail(owner, envelope.id)).valid).toBe(true);
    expect(await info(t1)).toMatchObject({ status: "signed" });
  });
});

describe("declining", () => {
  it("declines the Envelope, emails the sender, audits declined and stops every link", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const [ana, bo] = [person("ana"), person("bo")];
    const { envelope } = await sent(owner, doc, [ana, bo]);
    const [ta, tb] = [await linkOf(ana.email), await linkOf(bo.email)];
    const cookie = await verify(ta, ana.email);

    expect((await post(`/api/sign/${ta}/decline`, { reason: "" }, cookie)).status).toBe(422);
    const res = await post(`/api/sign/${ta}/decline`, { reason: "Wrong rent amount" }, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "declined" });

    const after = await detail(owner, envelope.id);
    expect(after.envelope.status).toBe("declined");
    expect(after.recipients[0]).toMatchObject({
      status: "declined",
      declineReason: "Wrong rent amount",
    });
    const [mail] = await outbox(owner.email);
    expect(mail?.subject).toBe(`${ana.name} declined to sign "Lease"`);
    expect(mail?.text).toContain("Reason: Wrong rent amount");
    const declined = (await trail(owner, envelope.id)).at(-1);
    expect(declined).toMatchObject({
      action: "declined",
      actor: ana.id,
      detail: { recipientId: ana.id, reason: "Wrong rent amount" },
    });
    for (const token of [ta, tb]) {
      const gone = await visit(`/api/sign/${token}`);
      expect(gone.status).toBe(404);
      expect(await gone.json()).toEqual(GONE);
    }
  });
});

describe("links that no longer work", () => {
  it("are the same 404 with no detail: voided, expired, reminded-over, unknown and malformed", async () => {
    const owner = await seed({ plan: "pro" });
    const doc = await uploaded(owner, "tiny.pdf");
    const [voidee, expiree, reminded] = [person("vic"), person("eve"), person("rem")];
    const voided = await sent(owner, doc, [voidee]);
    const expired = await sent(owner, doc, [expiree]);
    await sent(owner, doc, [reminded]);
    const [tv, te, tr] = [
      await linkOf(voidee.email),
      await linkOf(expiree.email),
      await linkOf(reminded.email),
    ];
    const grant = await verify(tv, voidee.email);

    await as(owner, `/api/envelopes/${voided.envelope.id}/void`, json("POST", { reason: "Typo" }));
    await rows(
      "UPDATE envelopes SET expires_at = ?1 WHERE tenant_id = ?2 AND id = ?3",
      Date.now() - 1,
      owner.tenantId,
      expired.envelope.id,
    );
    const remindedEnvelope = (
      await rows<{ envelope_id: string }>(
        "SELECT envelope_id FROM recipients WHERE email = ?1",
        reminded.email,
      )
    )[0]?.envelope_id;
    await as(owner, `/api/envelopes/${remindedEnvelope ?? ""}/remind`, { method: "POST" });

    const unknown = "A".repeat(43);
    for (const token of [tv, te, tr, unknown, "short"]) {
      for (const [method, path] of [
        ["GET", ""],
        ["POST", "/code"],
        ["POST", "/verify"],
        ["GET", "/content"],
        ["POST", "/sign"],
        ["POST", "/decline"],
      ] as const) {
        const res = await visit(`/api/sign/${token}${path}`, {
          method,
          headers: { cookie: grant },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(res.status, `${method} ${path} with ${token.slice(0, 4)}`).toBe(404);
        expect(await res.json()).toEqual(GONE);
      }
    }
    const fresh = (await outbox(reminded.email)).length;
    expect(fresh).toBe(2);
    expect((await visit(`/api/sign/${await linkOf(reminded.email)}`)).status).toBe(200);
    const denied = (await accessLog(owner.tenantId)).filter((e) => e.status === 404);
    // Voided and expired links are still logged to their Tenant; a reminded-over token is unknown.
    expect(denied).toHaveLength(12);
  });
});

describe("after completion", () => {
  it("retires the signing link and serves the sealed PDF on the completion link for 30 days", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const cy = { ...person("cy"), role: "cc" as const };
    const created = await as(owner, "/api/envelopes", json("POST", { documentId: doc.id }));
    const { envelope } = await created.json<Detail>();
    await as(
      owner,
      `/api/envelopes/${envelope.id}`,
      json("PUT", { title: "Lease", recipients: [ana, cy], fields: fieldsFor(ana) }),
    );
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
    });
    await as(owner, `/api/envelopes/${envelope.id}/send`, { method: "POST" });
    const token = await linkOf(ana.email);
    const cookie = await verify(token, ana.email);
    const { fields } = await detail(owner, envelope.id);
    expect((await signAll(token, cookie, fields)).status).toBe(200);
    await instance.waitForStatus("complete");
    expect((await detail(owner, envelope.id)).envelope.status).toBe("completed");

    expect(await (await visit(`/api/sign/${token}`)).json()).toEqual(GONE);
    const sealed = await sha256(
      await (await as(owner, `/api/envelopes/${envelope.id}/content`)).arrayBuffer(),
    );
    for (const [who, role] of [
      [ana, "signer"],
      [cy, "cc"],
    ] as const) {
      const fresh = await linkOf(who.email);
      expect(fresh).not.toBe(token);
      expect(await info(fresh)).toEqual({
        status: "signed",
        title: "Lease",
        role,
        signedAvailable: true,
      });
      const pdf = await visit(`/api/sign/${fresh}/content`);
      expect(pdf.status).toBe(200);
      expect(await sha256(await pdf.arrayBuffer())).toBe(sealed);
    }
    const downloads = (await accessLog(owner.tenantId)).filter((e) => e.action === "download");
    expect(downloads.map((e) => e.status)).toEqual([200, 200]);

    await rows(
      "UPDATE envelopes SET completed_at = ?1 WHERE tenant_id = ?2 AND id = ?3",
      Date.now() - 31 * 24 * 60 * 60 * 1000,
      owner.tenantId,
      envelope.id,
    );
    const late = await linkOf(cy.email);
    expect(await info(late)).toMatchObject({ signedAvailable: false });
    expect((await visit(`/api/sign/${late}/content`)).status).toBe(404);
  });
});

describe("tenancy", () => {
  it("a token for Envelope X reads X whatever else the request names, and a grant for X opens nothing else", async () => {
    const a = await seed();
    const b = await seed();
    const docA = await uploaded(a, "tiny.pdf");
    const docB = await uploaded(b, "10p.pdf");
    const [ana, bo] = [person("ana"), person("bo")];
    await sent(a, docA, [ana]);
    const envB = await sent(b, docB, [bo]);
    const [ta, tb] = [await linkOf(ana.email), await linkOf(bo.email)];
    const ca = await verify(ta, ana.email);

    const res = await visit(
      `/api/sign/${ta}/content?envelopeId=${envB.envelope.id}&tenant=${b.tenantId}`,
      { headers: { cookie: ca, authorization: `Bearer ${b.token}` } },
    );
    expect(await sha256(await res.arrayBuffer())).toBe(await sha256(fixture("tiny.pdf")));
    expect((await visit(`/api/sign/${tb}/content`, { headers: { cookie: ca } })).status).toBe(401);
    const theirs = envB.fields[0]?.id ?? "";
    const cross = await post(
      `/api/sign/${ta}/sign`,
      { values: { [theirs]: PNG }, consent: true },
      ca,
    );
    expect(cross.status).toBe(422);
    expect((await detail(b, envB.envelope.id)).fields.every((f) => f.value === null)).toBe(true);
    expect((await accessLog(b.tenantId)).some((e) => e.resource.includes(ana.id))).toBe(false);
  });
});
