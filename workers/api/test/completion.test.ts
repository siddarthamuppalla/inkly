import {
  verifyChain,
  type AuditEvent,
  type DocumentInfo,
  type EnvelopeId,
  type EnvelopeInfo,
  type TenantId,
} from "@inkly/domain";
import { getEnvelope } from "@inkly/storage";
import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { envelopeObject } from "../src/envelope/do.ts";
import app, { type Env } from "../src/index.ts";
import { rows } from "./d1.ts";
import {
  as,
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

// T3.5: the EnvelopeLifecycle Workflow (reminders, expiry, finalize) and Finalize itself.
// Signing is T3.3's; these tests sign by writing the rows, then call the seam it ends with.

interface Detail {
  envelope: EnvelopeInfo;
}

interface Trail {
  events: AuditEvent[];
  chain: { valid: boolean; head: string };
}

/** A 2×1 PNG, as a drawn signature. */
const SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGOQcj8k5X4IAAasAkez8fvzAAAAAElFTkSuQmCC";
const SIGN_LINK = /\/sign\/([A-Za-z0-9_-]{43})\b/;
const STAMPED_TEXT = "ACME-42 Ltd";

function person(label: string, role: "signer" | "cc" = "signer") {
  const id = `rcp_${label}${crypto.randomUUID().slice(0, 8)}`;
  return { id, name: `${label} Tester`, email: uniqueEmail(label), role, routingOrder: 1 };
}

type Person = ReturnType<typeof person>;

const rect = (y: number) => ({ x: 0.1, y, w: 0.4, h: 0.05 });

/** A draft of `doc` where each signer has a signature field; the first also a text and a date. */
async function drafted(
  who: Seeded,
  doc: DocumentInfo,
  recipients: Person[],
  extra: Record<string, unknown> = {},
): Promise<EnvelopeInfo> {
  const created = await as(who, "/api/envelopes", json("POST", { documentId: doc.id }));
  const { envelope } = await created.json<Detail>();
  const signers = recipients.filter((r) => r.role === "signer");
  const fields = signers.flatMap((r, i) => [
    { recipientId: r.id, kind: "signature", page: 1, rect: rect(0.6 + i * 0.1) },
    ...(i === 0
      ? [
          { recipientId: r.id, kind: "text", page: 1, rect: rect(0.4) },
          { recipientId: r.id, kind: "date", page: 1, rect: rect(0.5) },
        ]
      : []),
  ]);
  const res = await as(
    who,
    `/api/envelopes/${envelope.id}`,
    json("PUT", { title: "Lease", recipients, fields, ...extra }),
  );
  if (res.status !== 200) throw new Error(`PUT returned ${String(res.status)} ${await res.text()}`);
  return envelope;
}

async function send(who: Seeded, id: string): Promise<EnvelopeInfo> {
  const res = await as(who, `/api/envelopes/${id}/send`, { method: "POST" });
  if (res.status !== 200) throw new Error(`send returned ${String(res.status)}`);
  return (await res.json<Detail>()).envelope;
}

async function trail(who: Seeded, id: string): Promise<Trail> {
  return (await as(who, `/api/envelopes/${id}/audit`)).json<Trail>();
}

async function status(who: Seeded, id: string): Promise<EnvelopeInfo> {
  return (await (await as(who, `/api/envelopes/${id}`)).json<Detail>()).envelope;
}

async function stub(tenantId: TenantId, id: string) {
  const envelope = await getEnvelope(tenantId, env, id as EnvelopeId);
  if (!envelope) throw new Error(`no envelope ${id}`);
  return {
    ref: { tenantId, envelopeId: envelope.id },
    object: envelopeObject(env, tenantId, envelope),
  };
}

/** What T3.3's sign route leaves behind: every signer signed and their Fields filled. */
async function signEveryone(id: string): Promise<void> {
  const at = Date.now();
  await rows(
    "UPDATE recipients SET status = 'signed', viewed_at = ?2, signed_at = ?2 WHERE envelope_id = ?1 AND role = 'signer'",
    id,
    at,
  );
  await rows(
    "UPDATE fields SET value = ?2 WHERE envelope_id = ?1 AND kind IN ('signature', 'initials')",
    id,
    SIGNATURE_PNG,
  );
  await rows(
    "UPDATE fields SET value = ?2 WHERE envelope_id = ?1 AND kind = 'text'",
    id,
    STAMPED_TEXT,
  );
  await rows("UPDATE fields SET value = '2026-10-18' WHERE envelope_id = ?1 AND kind = 'date'", id);
}

async function versionCount(who: Seeded, doc: DocumentInfo): Promise<number> {
  const res = await as(who, `/api/documents/${doc.id}/versions`);
  return (await res.json<{ versions: unknown[] }>()).versions.length;
}

/** `bindings` as production without the seal secrets. */
function withoutSealKey(bindings: Env): Env {
  const rest = { ...bindings };
  delete rest.SEAL_PRIVATE_KEY;
  delete rest.SEAL_CERTIFICATE;
  return rest;
}

async function pemOf(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** `verify-pdf --signed` and pdftotext on `bytes`, run in Node through PDF_TOOLS. */
async function checkSealed(bytes: Uint8Array, certificate: string, expectPages: number) {
  const res = await env.PDF_TOOLS.fetch("http://pdf-tools/", {
    method: "POST",
    body: JSON.stringify({ pdf: base64(bytes), certificate, expectPages }),
  });
  return res.json<{ ok: boolean; output: string; text: string }>();
}

describe("EnvelopeLifecycle", () => {
  it("starts on send with the Envelope's id and waits for every signature", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana")]);
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await send(owner, envelope.id);

    expect(await instance.waitForStepResult({ name: "read envelope" })).toMatchObject({
      status: "sent",
    });
    const live = await env.ENVELOPE_LIFECYCLE.get(envelope.id);
    expect(["running", "waiting"]).toContain((await live.status()).status);
  });

  it("reminds pending signers with a fresh link when the wait times out, audited as system", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const ana = person("ana");
    const envelope = await drafted(owner, doc, [ana]);
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: "wait for signatures", index: 1 });
    });
    await send(owner, envelope.id);

    expect(await instance.waitForStepResult({ name: "remind" })).toEqual({ reminded: 1 });
    const { events, chain } = await trail(owner, envelope.id);
    expect(events.at(-1)).toMatchObject({
      action: "reminded",
      actor: "system",
      detail: { recipientId: ana.id, round: 1 },
    });
    expect(chain.valid).toBe(true);
    const mail = await outbox(ana.email);
    expect(mail.map((m) => m.subject)).toEqual([
      'Reminder: please sign "Lease"',
      expect.any(String),
    ]);
    const [fresh, first] = mail.map((m) => SIGN_LINK.exec(m.text)?.[1]);
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(first);
    await instance.waitForStepResult({ name: "read envelope", index: 2 });
  });

  it("expires the Envelope at expires_at, audits expired and tells the sender", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana")], { expiresInDays: 1 });
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await instance.modify(async (m) => {
      await m.forceEventTimeout({ name: "wait for signatures", index: 1 });
    });
    const sent = await send(owner, envelope.id);

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toBe("expired");
    expect((await status(owner, envelope.id)).status).toBe("expired");
    const { events, chain } = await trail(owner, envelope.id);
    expect(events.at(-1)).toMatchObject({
      action: "expired",
      actor: "system",
      detail: { expiresAt: sent.expiresAt },
    });
    expect(chain.valid).toBe(true);
    expect((await outbox(owner.email)).map((m) => m.subject)).toContain('"Lease" expired');
  });

  it("ends when the Envelope is voided", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana")]);
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await send(owner, envelope.id);
    await instance.waitForStepResult({ name: "read envelope" });

    const res = await as(
      owner,
      `/api/envelopes/${envelope.id}/void`,
      json("POST", { reason: "Wrong file" }),
    );
    expect(res.status).toBe(200);
    await instance.waitForStatus("terminated");
  });
});

describe("completing an Envelope", () => {
  it("finalizes once all signed: a sealed Version that pyHanko validates, retried after a failure", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "10p.pdf");
    const [ana, bo, cy] = [person("ana"), person("bo"), person("cy", "cc")];
    const envelope = await drafted(owner, doc, [ana, bo, cy]);
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepError({ name: "finalize" }, new Error("no seal key yet"), 1);
    });
    await send(owner, envelope.id);
    await instance.waitForStepResult({ name: "read envelope" });

    await signEveryone(envelope.id);
    const { ref, object } = await stub(owner.tenantId, envelope.id);
    const marked = await object.markAllSigned(ref, ORIGIN);
    expect(marked.ok && marked.value.envelope.status).toBe("completing");

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toBe("completed");
    const done = await status(owner, envelope.id);
    expect(done).toMatchObject({ status: "completed", finalVersion: 2 });
    expect(done.completedAt).not.toBeNull();
    expect(await versionCount(owner, doc)).toBe(2);

    const content = await as(owner, `/api/envelopes/${envelope.id}/content`);
    expect(content.status).toBe(200);
    const sealed = new Uint8Array(await content.arrayBuffer());
    const original = new Uint8Array(
      await (await as(owner, `/api/documents/${doc.id}/versions/1/content`)).arrayBuffer(),
    );
    expect(await sha256(sealed)).not.toBe(await sha256(original));

    const { events, chain } = await trail(owner, envelope.id);
    expect(chain.valid).toBe(true);
    expect(verifyChain(events).valid).toBe(true);
    const completed = events.at(-1);
    expect(completed).toMatchObject({ action: "completed", actor: "system" });
    expect(completed?.detail).toEqual({ version: 2, sha256: await sha256(sealed) });

    const cert = await app.request(`${ORIGIN}/api/seal-certificate`, {}, hooks);
    expect(cert.status).toBe(200);
    expect(cert.headers.get("content-type")).toBe("application/x-pem-file");
    const pem = await pemOf(cert);
    expect(pem).toContain("-----BEGIN CERTIFICATE-----");

    const probe = await checkSealed(sealed, pem, 0);
    const pages = probe.text.split("\f").filter((p, i, all) => i < all.length - 1 || p.trim());
    const certificatePages = pages.filter((p) => p.includes("Certificate of completion"));
    expect(certificatePages.length).toBeGreaterThan(0);
    expect(pages.slice(0, doc.pages).some((p) => p.includes("Certificate of completion"))).toBe(
      false,
    );
    expect(pages[0]).toContain(STAMPED_TEXT);
    const verified = await checkSealed(sealed, pem, doc.pages + certificatePages.length);
    expect(verified.output).toMatch(/signature ok: .*INTACT:TRUSTED,UNTOUCHED/);
    expect(verified.ok, verified.output).toBe(true);

    const tampered = sealed.slice();
    const at = Math.floor(tampered.length / 3);
    tampered[at] = (tampered[at] ?? 0) ^ 0xff;
    expect((await checkSealed(tampered, pem, doc.pages + certificatePages.length)).ok).toBe(false);

    for (const r of [ana, bo, cy]) {
      const [latest] = await outbox(r.email);
      expect(latest?.subject).toBe('"Lease" is complete');
      expect(latest?.text).toMatch(SIGN_LINK);
    }
    expect((await outbox(owner.email)).map((m) => m.subject)).toContain('Everyone signed "Lease"');
  });

  it("adds one Version however often finalize runs", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana")]);
    await using instance = await introspectWorkflowInstance(env.ENVELOPE_LIFECYCLE, envelope.id);
    await send(owner, envelope.id);
    await signEveryone(envelope.id);
    const { ref, object } = await stub(owner.tenantId, envelope.id);
    await object.markAllSigned(ref, ORIGIN);
    await instance.waitForStatus("complete");

    const again = await object.finalize(ref, ORIGIN);
    expect(again).toEqual({
      ok: true,
      value: {
        version: 2,
        sha256: (await trail(owner, envelope.id)).events.at(-1)?.detail["sha256"],
      },
    });
    expect(await versionCount(owner, doc)).toBe(2);
    expect(
      (await trail(owner, envelope.id)).events.filter((e) => e.action === "completed"),
    ).toHaveLength(1);
  });

  it("reuses a sealed Version that landed before a retry instead of adding a second", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana")]);
    await send(owner, envelope.id);
    await signEveryone(envelope.id);
    await rows("UPDATE envelopes SET status = 'completing' WHERE id = ?1", envelope.id);

    // A finalize that wrote its Version, then died before committing `completed`.
    const landed = await as(owner, `/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array(
        await (await as(owner, `/api/documents/${doc.id}/versions/1/content`)).arrayBuffer(),
      ),
    });
    expect(landed.status).toBe(201);
    const [v2] = await rows<{ sha256: string }>(
      "SELECT sha256 FROM document_versions WHERE document_id = ?1 AND n = 2",
      doc.id,
    );
    const { ref, object } = await stub(owner.tenantId, envelope.id);
    await runInDurableObject(object, async (_, state) => {
      await state.storage.put("sealing", { sha256: v2?.sha256, at: Date.now() });
    });

    const outcome = await object.finalize(ref, ORIGIN);
    expect(outcome).toEqual({ ok: true, value: { version: 2, sha256: v2?.sha256 } });
    expect(await versionCount(owner, doc)).toBe(2);
    expect(await status(owner, envelope.id)).toMatchObject({
      status: "completed",
      finalVersion: 2,
    });
  });

  it("leaves the Envelope completing when production has no seal key", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana")]);
    await send(owner, envelope.id);
    await signEveryone(envelope.id);
    await rows("UPDATE envelopes SET status = 'completing' WHERE id = ?1", envelope.id);
    const { ref, object } = await stub(owner.tenantId, envelope.id);

    const outcome = await runInDurableObject(object, async (instance) => {
      const target = instance as unknown as { env: Env };
      const configured = target.env;
      target.env = withoutSealKey(configured);
      try {
        return await instance.finalize(ref, ORIGIN);
      } finally {
        target.env = configured;
      }
    });
    expect(outcome).toMatchObject({ ok: false, code: "internal" });
    expect(!outcome.ok && outcome.message).toMatch(/SEAL_PRIVATE_KEY/);
    expect((await status(owner, envelope.id)).status).toBe("completing");
    expect(await versionCount(owner, doc)).toBe(1);
  });

  it("refuses to complete while a signer has not signed", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const envelope = await drafted(owner, doc, [person("ana"), person("bo")]);
    await send(owner, envelope.id);
    const { ref, object } = await stub(owner.tenantId, envelope.id);
    expect(await object.markAllSigned(ref, ORIGIN)).toMatchObject({ ok: false, code: "conflict" });
    expect((await status(owner, envelope.id)).status).toBe("sent");
  });
});

describe("GET /api/seal-certificate", () => {
  const unset = withoutSealKey(env);

  it("is a 404 without a configured key outside test hooks", async () => {
    expect((await app.request(`${ORIGIN}/api/seal-certificate`, {}, unset)).status).toBe(404);
  });

  it("publishes the per-isolate test key's certificate when test hooks are on", async () => {
    const withHooks = { ...unset, TEST_HOOKS: "enabled" };
    const first = await app.request(`${ORIGIN}/api/seal-certificate`, {}, withHooks);
    const second = await app.request(`${ORIGIN}/api/seal-certificate`, {}, withHooks);
    expect(first.status).toBe(200);
    const pem = await pemOf(first);
    expect(pem).toContain("-----BEGIN CERTIFICATE-----");
    expect(await pemOf(second)).toBe(pem);
    expect(pem).not.toBe(
      await pemOf(await app.request(`${ORIGIN}/api/seal-certificate`, {}, hooks)),
    );
  });
});
