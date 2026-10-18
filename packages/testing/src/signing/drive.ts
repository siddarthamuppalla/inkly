// verify-signing's driver (T3.6): one Envelope through the public API, as a sender and two
// sequential signers would, reading links and Signing codes from the Outbox test hook.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignerEnvelope } from "@inkly/domain";
import { PDFDocument } from "pdf-lib";

import { parseAuditTrail, type SignedEnvelope } from "./check.ts";

const FIXTURE = join(import.meta.dirname, "../../../../fixtures/pdfs/10p.pdf");
const SIGN_LINK = /\/sign\/([A-Za-z0-9_-]{43})\b/g;
/** A 1×1 PNG, the smallest signature image the signer API takes. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const COMPLETION_TIMEOUT_MS = 90_000;

export interface Step {
  readonly name: string;
  readonly ms: number;
}

export interface Driven {
  readonly envelopeId: string;
  readonly result: SignedEnvelope;
  /** Each step's duration, upload first, the signed PDF and certificate last. */
  readonly steps: readonly Step[];
  /** Upload → 2 signers → signed PDF + certificate, in ms. */
  readonly totalMs: number;
}

class Session {
  readonly baseUrl: string;
  readonly secret: string;

  constructor(baseUrl: string, secret: string) {
    this.baseUrl = baseUrl;
    this.secret = secret;
  }

  async fetch(path: string, init: RequestInit = {}, expect?: number): Promise<Response> {
    const res = await fetch(new URL(path, this.baseUrl), init);
    if (expect !== undefined && res.status !== expect) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(
        `${init.method ?? "GET"} ${path.replace(/[A-Za-z0-9_-]{43}/, "<token>")} returned ${String(res.status)}, expected ${String(expect)}: ${body}`,
      );
    }
    return res;
  }

  async mail(to: string): Promise<{ subject: string; text: string }[]> {
    const res = await this.fetch(
      `/__test/outbox?to=${encodeURIComponent(to)}`,
      { headers: { "x-test-hooks-secret": this.secret } },
      200,
    );
    return (
      ((await res.json()) as { messages?: { subject: string; text: string }[] }).messages ?? []
    );
  }

  /** Signing-link tokens mailed to `to`, newest first. */
  async links(to: string): Promise<string[]> {
    return (await this.mail(to)).flatMap((m) =>
      [...m.text.matchAll(SIGN_LINK)].map((x) => x[1] ?? ""),
    );
  }
}

const json = (
  method: string,
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

/** Signs as the Recipient whose newest link is in `email`'s inbox: code, view, fill, consent. */
async function sign(
  s: Session,
  email: string,
  values: (kind: string, id: string) => string,
): Promise<void> {
  const [token] = await s.links(email);
  if (!token) throw new Error(`no signing link in the Outbox for ${email}`);
  const at = `/api/sign/${token}`;
  await s.fetch(at, {}, 200);
  await s.fetch(`${at}/code`, json("POST", {}), 204);
  const mail = (await s.mail(email)).find((m) => m.subject.startsWith("Your signing code"));
  const code = /\b(\d{6})\b/.exec(mail?.text ?? "")?.[1];
  if (!code) throw new Error(`no Signing code in the Outbox for ${email}`);
  const verified = await s.fetch(`${at}/verify`, json("POST", { code }), 204);
  const cookie = (verified.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (cookie === "") throw new Error(`verifying ${email}'s code set no grant cookie`);
  const opened = SignerEnvelope.parse(
    await (await s.fetch(at, { headers: { cookie } }, 200)).json(),
  );
  if (opened.status !== "pending" || !opened.verified) {
    throw new Error(
      `${email}'s link is ${opened.status} after the code, not a verified pending signer`,
    );
  }
  await (await s.fetch(`${at}/content`, { headers: { cookie } }, 200)).arrayBuffer();
  const filled = Object.fromEntries(
    opened.fields.filter((f) => f.kind !== "date").map((f) => [f.id, values(f.kind, f.id)]),
  );
  await s.fetch(`${at}/sign`, json("POST", { values: filled, consent: true }, { cookie }), 200);
}

/** Drives one two-signer sequential Envelope of 10p.pdf to completion and downloads the result. */
export async function driveEnvelope(baseUrl: string, secret: string): Promise<Driven> {
  const s = new Session(baseUrl, secret);
  const steps: Step[] = [];
  let mark = performance.now();
  const step = (name: string) => {
    const now = performance.now();
    steps.push({ name, ms: Math.round(now - mark) });
    mark = now;
  };

  const seeded = await s.fetch(
    "/__test/seed",
    json("POST", {}, { "x-test-hooks-secret": secret }),
    201,
  );
  const { token } = (await seeded.json()) as { token: string };
  const auth = { authorization: `Bearer ${token}` };
  const api = (method: string, path: string, body: unknown, status: number) =>
    s.fetch(
      path,
      body === undefined ? { method, headers: auth } : json(method, body, auth),
      status,
    );

  const start = performance.now();
  mark = start;
  const original = readFileSync(FIXTURE);
  const uploaded = await s.fetch(
    "/api/documents?filename=verify-signing.pdf",
    { method: "POST", headers: { ...auth, "content-type": "application/pdf" }, body: original },
    201,
  );
  const documentId = ((await uploaded.json()) as { document: { id: string } }).document.id;
  step("upload");

  const created = await api("POST", "/api/envelopes", { documentId }, 201);
  const envelopeId = ((await created.json()) as { envelope: { id: string } }).envelope.id;
  const run = randomBytes(4).toString("hex");
  const ana = `verify-signing-ana-${run}@verify.inkly.test`;
  const ben = `verify-signing-ben-${run}@verify.inkly.test`;
  const field = (recipientId: string, kind: string, page: number, y: number) => ({
    recipientId,
    kind,
    page,
    rect: { x: 0.1, y, w: 0.4, h: 0.05 },
  });
  await api(
    "PUT",
    `/api/envelopes/${envelopeId}`,
    {
      title: "verify-signing lease",
      orderMode: "sequential",
      recipients: [
        { id: "rcp_ana", name: "Ana Ruiz", email: ana, role: "signer", routingOrder: 1 },
        { id: "rcp_ben", name: "Ben Ode", email: ben, role: "signer", routingOrder: 2 },
      ],
      fields: [
        field("rcp_ana", "signature", 1, 0.8),
        field("rcp_ana", "text", 1, 0.3),
        field("rcp_ana", "date", 1, 0.9),
        field("rcp_ben", "initials", 2, 0.7),
        field("rcp_ben", "signature", 2, 0.8),
        field("rcp_ben", "text", 2, 0.4),
      ],
    },
    200,
  );
  const pinned = await bytesOf(
    await api("GET", `/api/envelopes/${envelopeId}/content`, undefined, 200),
  );
  const originalPages = (await PDFDocument.load(pinned)).getPageCount();
  await api("POST", `/api/envelopes/${envelopeId}/send`, undefined, 200);
  step("draft and send");

  if ((await s.links(ben)).length !== 0)
    throw new Error("signer 2 was emailed before signer 1 signed");
  const typed: Record<string, string> = {};
  const values = (who: string) => (kind: string, id: string) => {
    if (kind !== "text") return PNG;
    typed[id] = `${who} verify-signing ${run}`;
    return typed[id];
  };
  await sign(s, ana, values("Ana"));
  step("signer 1 (Ana) signs");
  if ((await s.links(ben)).length !== 1)
    throw new Error("signer 2 was not emailed after signer 1 signed");
  await sign(s, ben, values("Ben"));
  step("signer 2 (Ben) signs");

  let status = "";
  const deadline = performance.now() + COMPLETION_TIMEOUT_MS;
  while (status !== "completed" && performance.now() < deadline) {
    const res = await api("GET", `/api/envelopes/${envelopeId}`, undefined, 200);
    status = ((await res.json()) as { envelope: { status: string } }).envelope.status;
    if (status !== "completed") await new Promise((r) => setTimeout(r, 500));
  }
  if (status !== "completed") {
    throw new Error(
      `the Envelope is ${status} ${String(COMPLETION_TIMEOUT_MS / 1000)} s after both signed`,
    );
  }
  step("finalize (completing → completed)");

  const signedPdf = await bytesOf(
    await api("GET", `/api/envelopes/${envelopeId}/content`, undefined, 200),
  );
  const certificatePem = await (await s.fetch("/api/seal-certificate", {}, 200)).text();
  step("download signed PDF + seal certificate");
  const totalMs = Math.round(performance.now() - start);

  const [completion] = await s.links(ana);
  const viaLink = await bytesOf(await s.fetch(`/api/sign/${completion ?? ""}/content`, {}, 200));
  if (Buffer.compare(Buffer.from(viaLink), Buffer.from(signedPdf)) !== 0) {
    throw new Error(
      "the completion link serves different bytes from GET /api/envelopes/:id/content",
    );
  }

  const audit = parseAuditTrail(
    await (await api("GET", `/api/envelopes/${envelopeId}/audit`, undefined, 200)).json(),
  );
  const dates = audit.events
    .filter((e) => e.action === "signed")
    .flatMap((e) => (e.detail["fields"] as { kind: string; value?: unknown }[] | undefined) ?? [])
    .flatMap((f) => (f.kind === "date" && typeof f.value === "string" ? [f.value] : []));
  if (dates.length !== 1)
    throw new Error(`the signed events record ${String(dates.length)} date values, expected 1`);

  return {
    envelopeId,
    steps,
    totalMs,
    result: {
      signedPdf,
      originalPages,
      certificatePem,
      stampedText: [...Object.values(typed), ...dates],
      audit,
    },
  };
}
