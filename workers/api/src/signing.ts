import {
  issueSignerGrant,
  resolveSignerToken,
  signerVerified,
  signingCodeSendAllowed,
  type OpenSigner,
  type ResolvedSigner,
  type SignedSigner,
} from "@inkly/auth";
import {
  AppError,
  SignerCode,
  SignerDecline,
  SignerSign,
  type SignerEnvelope,
  type SignerField,
} from "@inkly/domain";
import { accessDenied, accessGranted, logEvent, type AccessAction } from "@inkly/domain/log";
import {
  appendAccessLog,
  getEnvelope,
  getVersion,
  listFields,
  listRecipients,
  openVersion,
  type EnvelopeRow,
} from "@inkly/storage";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

import { SIGNED_PDF_DAYS, signedPdf } from "./envelope/content.ts";
import { envelopeSender, signerObject, type EnvelopeOutcome, type Signer } from "./envelope/do.ts";
import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";

// T3.3 signer API at /api/sign/:token, public. packages/auth turns the token into the owning
// TenantId and Recipient; every request is logged in that Tenant's access log, and every
// change goes through the Envelope DO, which audits it. A link that stopped working is the
// same 404 whatever the reason.

type SignContext = Context<{ Bindings: Env }>;

export const signingRoutes = new Hono<{ Bindings: Env }>();

const GRANT_COOKIE = "inkly_sign";
const GONE = { error: "not_found", message: "This link is no longer available" } as const;

signingRoutes.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "private, no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex");
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `GET …/content` serves the sealed PDF: completed, and for SIGNED_PDF_DAYS after. */
function signedPdfAvailable(envelope: EnvelopeRow, now: number): boolean {
  const { status, finalVersion, completedAt } = envelope;
  return (
    status === "completed" &&
    finalVersion !== null &&
    completedAt !== null &&
    now <= completedAt + SIGNED_PDF_DAYS * DAY_MS
  );
}

const ipOf = (c: SignContext) => c.req.header("cf-connecting-ip") ?? null;
const userAgentOf = (c: SignContext) => c.req.header("user-agent") ?? null;

/** Appends a signer entry to the Envelope owner's access log. */
async function logSigner(
  c: SignContext,
  signer: ResolvedSigner,
  action: AccessAction,
  status: 200 | 401 | 404 | 422 | 429,
): Promise<void> {
  const fields = {
    actorTenantId: signer.tenantId,
    actorUserId: signer.recipientId,
    action,
    resource: `envelope ${signer.envelopeId} document ${signer.documentId}`,
    documentId: signer.documentId,
    ip: ipOf(c),
    userAgent: userAgentOf(c),
  };
  const entry = status === 200 ? accessGranted(fields) : accessDenied({ ...fields, status });
  logEvent(entry);
  await appendAccessLog(signer.tenantId, c.env, entry);
}

function resolve(c: SignContext): Promise<ResolvedSigner | null> {
  return resolveSignerToken(c.env, c.req.param("token") ?? "", Date.now());
}

/** The open link the token names; otherwise the logged 404 every other case shares. */
async function openSigner(c: SignContext, action: AccessAction): Promise<OpenSigner | Response> {
  const signer = await resolve(c);
  if (signer?.kind === "open") return signer;
  if (signer) await logSigner(c, signer, action, 404);
  return c.json(GONE, 404);
}

function verified(c: SignContext, signer: OpenSigner): Promise<boolean> {
  return signerVerified(c.env, signer, getCookie(c, GRANT_COOKIE), Date.now());
}

/** The open link of a signer who entered their code in this browser; otherwise a logged 401. */
async function verifiedSigner(
  c: SignContext,
  action: AccessAction,
): Promise<OpenSigner | Response> {
  const signer = await openSigner(c, action);
  if (signer instanceof Response) return signer;
  if (await verified(c, signer)) return signer;
  await logSigner(c, signer, action, 401);
  return c.json({ error: "unauthenticated", message: "Enter the code we emailed you first" }, 401);
}

function call(c: SignContext, signer: OpenSigner) {
  const ref = { tenantId: signer.tenantId, envelopeId: signer.envelopeId };
  const who: Signer = {
    recipientId: signer.recipientId,
    tokenHash: signer.tokenHash,
    ip: ipOf(c),
    userAgent: userAgentOf(c),
  };
  return { object: signerObject(c.env, signer), ref, who };
}

/**
 * Logs a DO refusal and turns it into the response: a link that stopped working meanwhile
 * is the usual 404, anything else its AppError.
 */
async function refused(
  c: SignContext,
  signer: OpenSigner,
  action: AccessAction,
  outcome: Extract<EnvelopeOutcome<unknown>, { ok: false }>,
): Promise<Response> {
  const error = new AppError(outcome.code, outcome.message);
  const status = error.status === 401 || error.status === 422 ? error.status : 404;
  await logSigner(c, signer, action, status);
  if (status === 404) return c.json(GONE, 404);
  throw error;
}

/** Parses a body with `schema`, logging a malformed one as a 422 against the signer. */
async function body<S extends Parameters<typeof parseJson>[1]>(
  c: SignContext,
  signer: OpenSigner,
  action: AccessAction,
  schema: S,
) {
  return parseJson(c.req.raw, schema).catch(async (error: unknown) => {
    if (error instanceof AppError && error.code === "invalid_input") {
      await logSigner(c, signer, action, 422);
    }
    throw error;
  });
}

signingRoutes.get("/:token", async (c) => {
  const signer = await resolve(c);
  if (!signer || signer.kind === "gone") {
    if (signer) await logSigner(c, signer, "read", 404);
    return c.json(GONE, 404);
  }
  const envelope = await getEnvelope(signer.tenantId, c.env, signer.envelopeId);
  if (!envelope) return c.json(GONE, 404);
  await logSigner(c, signer, "read", 200);
  if (signer.kind === "signed") {
    const done: SignerEnvelope = {
      status: "signed",
      title: envelope.title,
      role: signer.role,
      signedAvailable: signedPdfAvailable(envelope, Date.now()),
    };
    return c.json(done);
  }
  const [sender, recipients, isVerified] = await Promise.all([
    envelopeSender(c.env, signer.tenantId, envelope),
    listRecipients(signer.tenantId, c.env, envelope.id),
    verified(c, signer),
  ]);
  let fields: SignerField[] = [];
  let pages: number | null = null;
  if (isVerified) {
    const [all, version] = await Promise.all([
      listFields(signer.tenantId, c.env, envelope.id),
      getVersion(signer.tenantId, c.env, envelope.documentId, envelope.version),
    ]);
    fields = all
      .filter((f) => f.recipientId === signer.recipientId)
      .map(({ id, kind, page, rect, required }) => ({ id, kind, page, rect, required }));
    pages = version?.pages ?? null;
  }
  const pending: SignerEnvelope = {
    status: "pending",
    title: envelope.title,
    message: envelope.message,
    sender,
    recipient: { name: recipients.find((r) => r.id === signer.recipientId)?.name ?? "" },
    verified: isVerified,
    pages,
    fields,
  };
  return c.json(pending);
});

signingRoutes.post("/:token/code", async (c) => {
  const signer = await openSigner(c, "unlock");
  if (signer instanceof Response) return signer;
  if (!(await signingCodeSendAllowed(c.env, signer.recipientId))) {
    await logSigner(c, signer, "unlock", 429);
    throw new AppError("rate_limited", "Too many codes asked for. Try again in 10 minutes.");
  }
  const { object, ref, who } = call(c, signer);
  const outcome = await object.sendCode(ref, who);
  if (!outcome.ok) return refused(c, signer, "unlock", outcome);
  await logSigner(c, signer, "unlock", 200);
  return c.body(null, 204);
});

signingRoutes.post("/:token/verify", async (c) => {
  const signer = await openSigner(c, "unlock");
  if (signer instanceof Response) return signer;
  const { code } = await body(c, signer, "unlock", SignerCode);
  const { object, ref, who } = call(c, signer);
  const outcome = await object.verifyCode(ref, who, code);
  if (!outcome.ok) return refused(c, signer, "unlock", outcome);
  const grant = await issueSignerGrant(c.env, signer, Date.now());
  setCookie(c, GRANT_COOKIE, grant.value, {
    path: `/api/sign/${c.req.param("token")}`,
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    maxAge: grant.maxAgeSeconds,
  });
  await logSigner(c, signer, "unlock", 200);
  return c.body(null, 204);
});

/** The sealed PDF for a link of a completed Envelope; no code is needed, as the link itself was just mailed. */
async function signedContent(c: SignContext, signer: SignedSigner): Promise<Response> {
  const envelope = await getEnvelope(signer.tenantId, c.env, signer.envelopeId);
  const pdf = envelope && (await signedPdf(signer.tenantId, c.env, envelope));
  await logSigner(c, signer, pdf ? "download" : "read-content", pdf ? 200 : 404);
  return pdf ?? c.json(GONE, 404);
}

signingRoutes.get("/:token/content", async (c) => {
  const resolved = await resolve(c);
  if (resolved?.kind === "signed") return signedContent(c, resolved);
  const signer = await verifiedSigner(c, "read-content");
  if (signer instanceof Response) return signer;
  const opened = await openVersion(signer.tenantId, c.env, signer.documentId, signer.version);
  if (!opened) return c.json(GONE, 404);
  const { object, ref, who } = call(c, signer);
  const outcome = await object.viewed(ref, who);
  if (!outcome.ok) {
    await opened.object.body.cancel();
    return refused(c, signer, "read-content", outcome);
  }
  await logSigner(c, signer, "read-content", 200);
  return new Response(opened.object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(opened.object.size),
      "content-disposition": "inline",
    },
  });
});

signingRoutes.post("/:token/sign", async (c) => {
  const signer = await verifiedSigner(c, "write");
  if (signer instanceof Response) return signer;
  const input = await body(c, signer, "write", SignerSign);
  const { object, ref, who } = call(c, signer);
  const origin = c.env.BETTER_AUTH_URL ?? new URL(c.req.url).origin;
  const outcome = await object.sign(ref, who, input, origin);
  if (!outcome.ok) return refused(c, signer, "write", outcome);
  await logSigner(c, signer, "write", 200);
  return c.json({ status: "signed" });
});

signingRoutes.post("/:token/decline", async (c) => {
  const signer = await verifiedSigner(c, "write");
  if (signer instanceof Response) return signer;
  const { reason } = await body(c, signer, "write", SignerDecline);
  const { object, ref, who } = call(c, signer);
  const outcome = await object.decline(ref, who, reason);
  if (!outcome.ok) return refused(c, signer, "write", outcome);
  await logSigner(c, signer, "write", 200);
  return c.json({ status: "declined" });
});

signingRoutes.all("*", (c) => c.json(GONE, 404));
