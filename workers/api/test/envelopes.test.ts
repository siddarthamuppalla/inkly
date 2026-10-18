import type { Role } from "@inkly/auth";
import {
  GENESIS,
  verifyChain,
  type AuditEvent,
  type DocumentInfo,
  type EnvelopeInfo,
  type FieldInfo,
  type RecipientInfo,
  type TenantId,
  type UserId,
} from "@inkly/domain";
import { listDurableObjectIds } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { envelopeRoutes } from "../src/envelopes.ts";
import { onAppError } from "../src/errors.ts";
import type { Env } from "../src/index.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { rows, tamperAuditEvents } from "./d1.ts";
import {
  accessLog,
  as,
  fixture,
  hooks,
  json,
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

interface Trail {
  events: AuditEvent[];
  chain: { valid: boolean; head: string };
}

const SIGN_LINK = /\/sign\/([A-Za-z0-9_-]{43})\b/;
const SENDER = { "cf-connecting-ip": "198.51.100.4", "user-agent": "SenderBrowser/2.0" };

async function create(who: Seeded, doc: DocumentInfo): Promise<Detail> {
  const res = await as(who, "/api/envelopes", json("POST", { documentId: doc.id }));
  if (res.status !== 201) throw new Error(`create returned ${String(res.status)}`);
  return res.json<Detail>();
}

function person(label: string, role: "signer" | "cc" = "signer", routingOrder = 1) {
  const id = `rcp_${label}${crypto.randomUUID().slice(0, 8).replaceAll("-", "")}`;
  return {
    id,
    name: `${label[0]?.toUpperCase() ?? ""}${label.slice(1)} Tester`,
    email: uniqueEmail(label),
    role,
    routingOrder,
  };
}

function signature(recipientId: string, page = 1) {
  return { recipientId, kind: "signature", page, rect: { x: 0.1, y: 0.8, w: 0.3, h: 0.05 } };
}

type Person = ReturnType<typeof person>;

function put(who: Seeded, id: string, body: Record<string, unknown>) {
  return as(who, `/api/envelopes/${id}`, json("PUT", { title: "Lease", ...body }));
}

/** A draft of `doc` with `recipients`, each signer given one signature field on page 1. */
async function drafted(
  who: Seeded,
  doc: DocumentInfo,
  recipients: Person[],
  extra: Record<string, unknown> = {},
): Promise<Detail> {
  const { envelope } = await create(who, doc);
  const fields = recipients.filter((r) => r.role === "signer").map((r) => signature(r.id));
  const res = await put(who, envelope.id, { recipients, fields, ...extra });
  if (res.status !== 200) throw new Error(`PUT returned ${String(res.status)} ${await res.text()}`);
  return res.json<Detail>();
}

function send(who: Seeded, id: string) {
  return as(who, `/api/envelopes/${id}/send`, { method: "POST", headers: SENDER });
}

async function trail(who: Seeded, id: string): Promise<Trail> {
  return (await as(who, `/api/envelopes/${id}/audit`)).json<Trail>();
}

async function signLinks(email: string): Promise<string[]> {
  return (await outbox(email)).flatMap((m) => SIGN_LINK.exec(m.text)?.[1] ?? []);
}

function appAs(who: { tenantId: TenantId; userId: string }, role: Role) {
  const session = {
    sessionId: "fixture-session",
    tenantId: who.tenantId,
    userId: who.userId as UserId,
    role,
  };
  const viewer = new Hono<{ Bindings: Env; Variables: TenantVars }>();
  viewer.onError(onAppError);
  viewer.use("*", async (c, next) => {
    c.set("session", session);
    c.set("tenantId", who.tenantId);
    await next();
  });
  viewer.route("/api/envelopes", envelopeRoutes);
  return (path: string, init: RequestInit = {}) => viewer.request(path, init, hooks);
}

describe("migration 0010", () => {
  it("creates the four tables and makes audit_events append-only", async () => {
    const tables = await rows<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('envelopes', 'recipients', 'fields', 'audit_events') ORDER BY name",
    );
    expect(tables.map((t) => t.name)).toEqual([
      "audit_events",
      "envelopes",
      "fields",
      "recipients",
    ]);

    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const { envelope } = await create(owner, doc);
    await expect(
      rows("UPDATE audit_events SET actor = 'forged' WHERE subject_id = ?1", envelope.id),
    ).rejects.toThrow(/append-only/);
    await expect(
      rows("DELETE FROM audit_events WHERE subject_id = ?1", envelope.id),
    ).rejects.toThrow(/append-only/);
    const [event] = await rows<{ actor: string }>(
      "SELECT actor FROM audit_events WHERE subject_id = ?1",
      envelope.id,
    );
    expect(event?.actor).toBe(owner.userId);
  });
});

describe("drafting an Envelope", () => {
  it("pins the Document's current Version, audits created and lives in the DO {tenantId}/{envelopeId}", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const draft = await create(owner, doc);
    expect(draft.envelope).toMatchObject({
      documentId: doc.id,
      version: 1,
      title: "10p",
      status: "draft",
      orderMode: "parallel",
      expiresInDays: 30,
      createdBy: owner.userId,
      sentAt: null,
    });
    expect(draft.envelope.id).toMatch(/^env_[a-f0-9]{32}$/);
    expect(draft.recipients).toEqual([]);

    const { events, chain } = await trail(owner, draft.envelope.id);
    expect(events.map((e) => e.action)).toEqual(["created"]);
    expect(events[0]).toMatchObject({ seq: 1, prevHash: GENESIS, actor: owner.userId });
    expect(chain.valid).toBe(true);

    const name = env.ENVELOPES.idFromName(`${owner.tenantId}/${draft.envelope.id}`).toString();
    const ids = (await listDurableObjectIds(env.ENVELOPES)).map((id) => id.toString());
    expect(ids).toContain(name);
  });

  it("replaces recipients and fields on PUT, keeping given ids and minting the rest", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const ana = person("ana");
    const cc = { ...person("cy", "cc"), id: undefined };
    const draft = await drafted(owner, doc, [ana], {
      message: "Please sign by Friday",
      orderMode: "sequential",
      expiresInDays: 7,
    });
    expect(draft.envelope).toMatchObject({
      message: "Please sign by Friday",
      orderMode: "sequential",
      expiresInDays: 7,
    });
    expect(draft.recipients.map((r) => r.id)).toEqual([ana.id]);
    expect(draft.fields).toHaveLength(1);
    expect(draft.fields[0]?.id).toMatch(/^fld_/);

    const res = await put(owner, draft.envelope.id, {
      recipients: [ana, cc],
      fields: [signature(ana.id, 2), { ...signature(ana.id, 3), kind: "date" }],
    });
    const next = await res.json<Detail>();
    expect(res.status).toBe(200);
    expect(next.envelope.orderMode).toBe("parallel");
    expect(next.recipients.map((r) => r.email)).toEqual([ana.email, cc.email]);
    expect(next.recipients[1]?.id).toMatch(/^rcp_[a-f0-9]{32}$/);
    expect(next.fields.map((f) => [f.page, f.kind])).toEqual([
      [2, "signature"],
      [3, "date"],
    ]);
    expect((await as(owner, `/api/envelopes/${draft.envelope.id}`)).status).toBe(200);
  });

  it("refuses a Trashed Document (409) and a malformed draft (422)", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const { envelope } = await create(owner, doc);
    expect((await put(owner, envelope.id, { fields: [signature("rcp_nobody")] })).status).toBe(422);
    await as(owner, `/api/documents/${doc.id}`, { method: "DELETE" });
    expect((await as(owner, "/api/envelopes", json("POST", { documentId: doc.id }))).status).toBe(
      409,
    );
  });

  it("deletes a draft and its rows, keeping its audit trail", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const { envelope } = await drafted(owner, doc, [person("ana")]);
    expect((await as(owner, `/api/envelopes/${envelope.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await as(owner, `/api/envelopes/${envelope.id}`)).status).toBe(404);
    for (const table of ["envelopes", "recipients", "fields"]) {
      const left = await rows(
        `SELECT 1 FROM ${table} WHERE tenant_id = ?1 AND ${table === "envelopes" ? "id" : "envelope_id"} = ?2`,
        owner.tenantId,
        envelope.id,
      );
      expect(left).toEqual([]);
    }
    expect(
      await rows("SELECT action FROM audit_events WHERE subject_id = ?1", envelope.id),
    ).toEqual([{ action: "created" }]);
  });
});

describe("sending an Envelope", () => {
  it("emails each signer a /sign/{token} link, stores only its sha256 and audits created, sent, notified", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const [ana, bo, cy] = [person("ana"), person("bo"), person("cy", "cc")];
    const { envelope } = await drafted(owner, doc, [ana, bo, cy]);

    const res = await send(owner, envelope.id);
    expect(res.status).toBe(200);
    const sent = await res.json<Detail>();
    expect(sent.envelope.status).toBe("sent");
    expect(sent.envelope.sentAt).not.toBeNull();
    expect(sent.envelope.expiresAt).toBe((sent.envelope.sentAt ?? 0) + 30 * 24 * 60 * 60 * 1000);
    expect(sent.recipients.map((r) => [r.email, r.status, r.notifiedAt !== null])).toEqual([
      [ana.email, "sent", true],
      [bo.email, "sent", true],
      [cy.email, "waiting", false],
    ]);

    const { events, chain } = await trail(owner, envelope.id);
    expect(events.map((e) => e.action)).toEqual(["created", "sent", "notified", "notified"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.slice(2).map((e) => e.detail["email"])).toEqual([ana.email, bo.email]);
    expect(events[1]).toMatchObject({
      ip: SENDER["cf-connecting-ip"],
      userAgent: SENDER["user-agent"],
    });
    expect(events[1]?.detail["sha256"]).toBe(doc.sha256);
    expect(chain).toEqual({ valid: true, head: events[3]?.hash });
    expect(verifyChain(events).valid).toBe(true);

    const stored = await rows<Record<string, unknown>>(
      "SELECT * FROM recipients WHERE tenant_id = ?1 AND envelope_id = ?2 ORDER BY routing_order, rowid",
      owner.tenantId,
      envelope.id,
    );
    for (const [i, signer] of [ana, bo].entries()) {
      const mail = await outbox(signer.email);
      expect(mail).toHaveLength(1);
      expect(mail[0]?.text).toContain("http://inkly.test/sign/");
      const [token] = await signLinks(signer.email);
      expect(token).toHaveLength(43);
      expect(stored[i]?.["token_hash"]).toBe(await sha256(new TextEncoder().encode(token)));
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain(token);
    }
    expect(stored[2]?.["token_hash"]).toBeNull();
    expect(await outbox(cy.email)).toEqual([]);
  });

  it("notifies only routing order 1 when sequential", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const [first, second] = [person("ana", "signer", 1), person("bo", "signer", 2)];
    const { envelope } = await drafted(owner, doc, [second, first], { orderMode: "sequential" });
    const sent = await (await send(owner, envelope.id)).json<Detail>();
    expect(sent.recipients.map((r) => [r.routingOrder, r.status])).toEqual([
      [1, "sent"],
      [2, "waiting"],
    ]);
    expect(await signLinks(first.email)).toHaveLength(1);
    expect(await outbox(second.email)).toEqual([]);
    const { events } = await trail(owner, envelope.id);
    expect(events.filter((e) => e.action === "notified").map((e) => e.detail["email"])).toEqual([
      first.email,
    ]);
  });

  it("refuses with 422 a draft with no signer, a signer without a signature field, a field off the Version or on a CC", async () => {
    const owner = await seed({ plan: "pro" });
    const doc = await uploaded(owner, "10p.pdf");
    const [ana, cy] = [person("ana"), person("cy", "cc")];
    const cases: [Record<string, unknown>, string][] = [
      [{ recipients: [cy], fields: [] }, "Add at least one signer"],
      [
        { recipients: [ana], fields: [{ ...signature(ana.id), kind: "initials" }] },
        `${ana.name} has no signature field`,
      ],
      [
        { recipients: [ana], fields: [signature(ana.id), signature(ana.id, 11)] },
        "A field is on page 11, but the document has 10 pages",
      ],
      [
        { recipients: [ana, cy], fields: [signature(ana.id), signature(cy.id)] },
        `${cy.name} gets a copy (CC) and can't have fields`,
      ],
    ];
    for (const [body, message] of cases) {
      const { envelope } = await create(owner, doc);
      expect((await put(owner, envelope.id, body)).status).toBe(200);
      const res = await send(owner, envelope.id);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "invalid_input", message });
      const after = await (await as(owner, `/api/envelopes/${envelope.id}`)).json<Detail>();
      expect(after.envelope.status).toBe("draft");
      expect((await trail(owner, envelope.id)).events.map((e) => e.action)).toEqual(["created"]);
    }
  });

  it("freezes a sent Envelope: PUT, DELETE and a second send are 409", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope } = await drafted(owner, doc, [ana]);
    expect((await send(owner, envelope.id)).status).toBe(200);
    expect((await put(owner, envelope.id, { recipients: [ana] })).status).toBe(409);
    expect((await as(owner, `/api/envelopes/${envelope.id}`, { method: "DELETE" })).status).toBe(
      409,
    );
    expect((await send(owner, envelope.id)).status).toBe(409);
    expect((await as(owner, `/api/envelopes/${envelope.id}`)).status).toBe(200);
  });

  it("keeps signing the pinned Version after the Document gets a new one", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const { envelope } = await create(owner, doc);
    const added = await as(owner, `/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: fixture("tiny.pdf"),
    });
    expect(added.status).toBe(201);
    const res = await as(owner, `/api/envelopes/${envelope.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(await sha256(await res.arrayBuffer())).toBe(doc.sha256);
    const log = await accessLog(owner.tenantId);
    expect(log.some((e) => e.action === "read-content" && e.resource.includes(envelope.id))).toBe(
      true,
    );
  });
});

describe("the envelope Limit", () => {
  it("stops a Free Tenant's 4th send this month with 402 and changes nothing; drafts are free", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const spare = await create(owner, doc);
    for (let i = 0; i < 3; i++) {
      const { envelope } = await drafted(owner, doc, [person("ana")]);
      expect((await send(owner, envelope.id)).status).toBe(200);
    }
    const ana = person("ana");
    const fourth = await drafted(owner, doc, [ana]);
    const res = await send(owner, fourth.envelope.id);
    expect(res.status).toBe(402);
    expect((await res.json<{ error: string }>()).error).toBe("limit_exceeded");
    const after = await (await as(owner, `/api/envelopes/${fourth.envelope.id}`)).json<Detail>();
    expect(after.envelope.status).toBe("draft");
    expect(after.recipients[0]?.status).toBe("waiting");
    expect((await trail(owner, fourth.envelope.id)).events).toHaveLength(1);
    expect(await outbox(ana.email)).toEqual([]);
    expect(await rows("SELECT envelopes FROM usage WHERE tenant_id = ?1", owner.tenantId)).toEqual([
      { envelopes: 3 },
    ]);
    expect((await as(owner, `/api/envelopes/${spare.envelope.id}`)).status).toBe(200);
  });

  it("cannot be overshot by concurrent sends", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const drafts = [];
    for (let i = 0; i < 6; i++) drafts.push(await drafted(owner, doc, [person("ana")]));
    const statuses = await Promise.all(
      drafts.map((d) => send(owner, d.envelope.id).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(3);
    expect(statuses.filter((s) => s === 402)).toHaveLength(3);
    const sent = await (
      await as(owner, "/api/envelopes?status=sent")
    ).json<{
      envelopes: EnvelopeInfo[];
    }>();
    expect(sent.envelopes).toHaveLength(3);
  });
});

describe("voiding and reminding", () => {
  it("voids a sent Envelope with a reason, audits it and emails pending signers", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope } = await drafted(owner, doc, [ana]);
    const path = `/api/envelopes/${envelope.id}/void`;
    expect((await as(owner, path, json("POST", { reason: "Wrong terms" }))).status).toBe(409);
    await send(owner, envelope.id);
    expect((await as(owner, path, json("POST", { reason: " " }))).status).toBe(422);

    const res = await as(owner, path, json("POST", { reason: "Wrong terms" }));
    expect(res.status).toBe(200);
    expect((await res.json<Detail>()).envelope.status).toBe("voided");
    const { events, chain } = await trail(owner, envelope.id);
    expect(events.at(-1)).toMatchObject({ action: "voided", detail: { reason: "Wrong terms" } });
    expect(chain.valid).toBe(true);
    const [latest] = await outbox(ana.email);
    expect(latest?.subject).toBe('"Lease" was voided');
    expect(latest?.text).toContain("Wrong terms");
    expect((await as(owner, path, json("POST", { reason: "again" }))).status).toBe(409);
    expect(
      (await as(owner, `/api/envelopes/${envelope.id}/remind`, { method: "POST" })).status,
    ).toBe(409);
  });

  it("reminds pending signers with a fresh link that replaces the old one", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const { envelope } = await drafted(owner, doc, [ana]);
    const remind = () => as(owner, `/api/envelopes/${envelope.id}/remind`, { method: "POST" });
    expect((await remind()).status).toBe(409);
    await send(owner, envelope.id);
    expect((await remind()).status).toBe(200);
    const [fresh, original] = await signLinks(ana.email);
    expect(fresh).not.toBe(original);
    const [stored] = await rows<{ token_hash: string }>(
      "SELECT token_hash FROM recipients WHERE tenant_id = ?1 AND envelope_id = ?2",
      owner.tenantId,
      envelope.id,
    );
    expect(stored?.token_hash).toBe(await sha256(new TextEncoder().encode(fresh)));
    const { events, chain } = await trail(owner, envelope.id);
    expect(events.map((e) => e.action)).toEqual(["created", "sent", "notified", "reminded"]);
    expect(chain.valid).toBe(true);
  });
});

describe("the audit trail", () => {
  it("returns events in seq order and reports a tampered row as an invalid chain", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const { envelope } = await drafted(owner, doc, [person("ana")]);
    await send(owner, envelope.id);
    const before = await trail(owner, envelope.id);
    expect(before.chain.valid).toBe(true);

    await tamperAuditEvents(
      "UPDATE audit_events SET detail = ?2 WHERE subject_id = ?1 AND seq = 2",
      envelope.id,
      '{"documentId":"doc_forged"}',
    );
    const after = await trail(owner, envelope.id);
    expect(after.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(after.chain.valid).toBe(false);
    expect(verifyChain(after.events)).toMatchObject({ valid: false, brokenAt: 2 });
  });
});

describe("who may reach an Envelope", () => {
  it("lets a viewer list and read but refuses every write with a logged 403", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const { envelope } = await drafted(owner, doc, [person("ana")]);
    const viewer = appAs(owner, "viewer");
    for (const path of [
      "/api/envelopes",
      `/api/envelopes/${envelope.id}`,
      `/api/envelopes/${envelope.id}/audit`,
      `/api/envelopes/${envelope.id}/content`,
    ]) {
      expect((await viewer(path)).status).toBe(200);
    }
    const writes: [string, string][] = [
      ["POST", "/api/envelopes"],
      ["PUT", `/api/envelopes/${envelope.id}`],
      ["DELETE", `/api/envelopes/${envelope.id}`],
      ["POST", `/api/envelopes/${envelope.id}/send`],
      ["POST", `/api/envelopes/${envelope.id}/void`],
      ["POST", `/api/envelopes/${envelope.id}/remind`],
    ];
    for (const [method, path] of writes) {
      expect(
        (await viewer(path, json(method, { documentId: doc.id, reason: "x", title: "x" }))).status,
      ).toBe(403);
    }
    const denied = (await accessLog(owner.tenantId)).filter((e) => e.status === 403);
    expect(denied).toHaveLength(writes.length);
    expect((await as(owner, `/api/envelopes/${envelope.id}`)).status).toBe(200);
  });

  it("answers 404, logged, to a Member of another Tenant on every route", async () => {
    const a = await seed();
    const b = await seed();
    const docB = await uploaded(b, "tiny.pdf");
    const { envelope } = await drafted(b, docB, [person("ana")]);
    const id = envelope.id;
    const attempts: [string, string, unknown?][] = [
      ["POST", "/api/envelopes", { documentId: docB.id }],
      ["GET", `/api/envelopes/${id}`],
      ["PUT", `/api/envelopes/${id}`, { title: "pwned" }],
      ["DELETE", `/api/envelopes/${id}`],
      ["POST", `/api/envelopes/${id}/send`],
      ["POST", `/api/envelopes/${id}/void`, { reason: "pwned" }],
      ["POST", `/api/envelopes/${id}/remind`],
      ["GET", `/api/envelopes/${id}/audit`],
      ["GET", `/api/envelopes/${id}/content`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await as(a, path, body === undefined ? { method } : json(method, body));
      expect(`${method} ${path} ${String(res.status)}`).toBe(`${method} ${path} 404`);
    }
    const listed = await (await as(a, "/api/envelopes")).json<{ envelopes: EnvelopeInfo[] }>();
    expect(listed.envelopes).toEqual([]);
    expect(
      (await as(a, "/api/envelopes", { headers: { "x-inkly-tenant": b.tenantId } })).status,
    ).toBe(403);
    const denied = (await accessLog(a.tenantId)).filter(
      (e) => e.status === 404 || e.status === 403,
    );
    expect(denied).toHaveLength(attempts.length + 1);
    const still = await (await as(b, `/api/envelopes/${id}`)).json<Detail>();
    expect(still.envelope).toMatchObject({ status: "draft", title: "Lease" });
    expect((await trail(b, id)).events).toHaveLength(1);
  });

  it("refuses an unknown status filter (422) and an unknown Document (404)", async () => {
    const owner = await seed();
    expect((await as(owner, "/api/envelopes?status=lost")).status).toBe(422);
    expect(
      (await as(owner, "/api/envelopes", json("POST", { documentId: "doc_missing" }))).status,
    ).toBe(404);
  });
});
