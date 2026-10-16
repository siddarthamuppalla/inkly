import {
  hashSharePassword,
  issueShareGrant,
  mintShareLinkId,
  mintShareToken,
  resolveShareLink,
  shareLinkUnlocked,
  unlockAttemptAllowed,
  verifySharePassword,
  type GoneShareLink,
  type OpenShareLink,
} from "@inkly/auth";
import {
  AppError,
  assertShareLinkAllowed,
  isWellFormedId,
  ShareLinkCreate,
  ShareUnlock,
  type DocumentId,
  type ShareLinkId,
} from "@inkly/domain";
import { accessDenied, accessGranted, logEvent, type AccessAction } from "@inkly/domain/log";
import {
  appendAccessLog,
  createShareLink,
  getDocument,
  getShareLink,
  listActivity,
  listShareLinks,
  openVersion,
  revokeShareLink,
} from "@inkly/storage";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";

import type { Env } from "./env.ts";
import { activityPage, pageOf, refuseViewers } from "./activity.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";
import { tenantPlan } from "./upload.ts";

// T2.3. Members manage links at /api/share-links (behind requireTenant); signed-out
// visitors open them at /api/share/:token, where packages/auth turns the token into the
// owning TenantId. Every visitor request is logged in that Tenant's access log.

export const shareLinkRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

shareLinkRoutes.use("*", viewersReadOnly);

function missing(c: TenantContext, action: AccessAction): Promise<Response> {
  return denyAccess(c, action, `${c.req.method} ${c.req.path}`, 404);
}

async function findDocument(c: TenantContext, raw: string) {
  return isWellFormedId(raw) ? getDocument(c.get("tenantId"), c.env, raw as DocumentId) : null;
}

shareLinkRoutes.get("/", async (c) => {
  const raw = c.req.query("documentId");
  const doc = raw === undefined ? undefined : await findDocument(c, raw);
  if (doc === null) return missing(c, "list");
  const links = await listShareLinks(c.get("tenantId"), c.env, doc ? { documentId: doc.id } : {});
  return c.json({ links });
});

shareLinkRoutes.post("/", async (c) => {
  const body = await parseJson(c.req.raw, ShareLinkCreate);
  const tenantId = c.get("tenantId");
  const doc = await findDocument(c, body.documentId);
  if (!doc) return missing(c, "write");
  if (doc.deletedAt !== null) {
    throw new AppError("conflict", "Restore this document from Trash before sharing it");
  }
  assertShareLinkAllowed(await tenantPlan(tenantId, c.env), body, Date.now());
  const { token, tokenHash } = await mintShareToken();
  const link = await createShareLink(tenantId, c.env, {
    id: mintShareLinkId(),
    documentId: doc.id,
    tokenHash,
    createdBy: c.get("session").userId,
    expiresAt: body.expiresAt,
    passwordHash: body.password === null ? null : await hashSharePassword(body.password),
    allowDownload: body.allowDownload,
  });
  return c.json({ link, url: `/s/${token}` }, 201);
});

shareLinkRoutes.post("/:id/revoke", async (c) => {
  const id = c.req.param("id");
  const link = isWellFormedId(id)
    ? await revokeShareLink(c.get("tenantId"), c.env, id as ShareLinkId)
    : null;
  return link ? c.json({ link }) : missing(c, "write");
});

shareLinkRoutes.get("/:id/activity", async (c) => {
  const refused = refuseViewers(c);
  if (refused) return refused;
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");
  const link = isWellFormedId(id) ? await getShareLink(tenantId, c.env, id as ShareLinkId) : null;
  if (!link) return missing(c, "list");
  const page = pageOf(c);
  const rows = await listActivity(
    tenantId,
    c.env,
    { shareLinkId: link.id },
    {
      before: page.before,
      limit: page.limit + 1,
    },
  );
  return c.json(activityPage(rows, page.limit));
});

// Public: /api/share/:token

type ShareContext = Context<{ Bindings: Env }>;

export const sharedRoutes = new Hono<{ Bindings: Env }>();

const GRANT_COOKIE = "inkly_share";
const GONE = { error: "not_found", message: "This link is no longer available" } as const;

sharedRoutes.use("*", async (c, next) => {
  await next();
  c.header("cache-control", "private, no-store");
  c.header("referrer-policy", "no-referrer");
  c.header("x-robots-tag", "noindex");
});

/** Appends a visitor entry to the link owner's access log. */
async function logVisit(
  c: ShareContext,
  link: OpenShareLink | GoneShareLink,
  action: AccessAction,
  status: 200 | 401 | 404 | 429,
): Promise<void> {
  const fields = {
    actorTenantId: link.tenantId,
    actorUserId: "share-link",
    action,
    resource: `document ${link.documentId}`,
    documentId: link.documentId,
    shareLinkId: link.linkId,
    ip: c.req.header("cf-connecting-ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  };
  const entry = status === 200 ? accessGranted(fields) : accessDenied({ ...fields, status });
  logEvent(entry);
  await appendAccessLog(link.tenantId, c.env, entry);
}

/** The open link the token names; otherwise the 404 every other case shares. */
async function openLink(c: ShareContext, action: AccessAction): Promise<OpenShareLink | Response> {
  const link = await resolveShareLink(c.env, c.req.param("token") ?? "", Date.now());
  if (link?.kind === "open") return link;
  if (link) await logVisit(c, link, action, 404);
  return c.json(GONE, 404);
}

function unlocked(c: ShareContext, link: OpenShareLink): Promise<boolean> {
  return shareLinkUnlocked(c.env, link, getCookie(c, GRANT_COOKIE), Date.now());
}

function disposition(kind: "inline" | "attachment", title: string): string {
  const filename = `${title}.pdf`;
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

sharedRoutes.get("/:token", async (c) => {
  const link = await openLink(c, "read");
  if (link instanceof Response) return link;
  const doc = await getDocument(link.tenantId, c.env, link.documentId);
  if (!doc) return c.json(GONE, 404);
  await logVisit(c, link, "read", 200);
  if (!(await unlocked(c, link))) return c.json({ locked: true });
  return c.json({
    locked: false,
    title: doc.title,
    pages: doc.pages,
    allowDownload: link.allowDownload,
  });
});

sharedRoutes.get("/:token/content", async (c) => {
  const download = c.req.query("download") === "1";
  const action = download ? "download" : "read-content";
  const link = await openLink(c, action);
  if (link instanceof Response) return link;
  if (!(await unlocked(c, link))) {
    await logVisit(c, link, action, 401);
    return c.json({ error: "unauthenticated", message: "Enter the password to open this" }, 401);
  }
  const doc = await getDocument(link.tenantId, c.env, link.documentId);
  const opened = doc && (await openVersion(link.tenantId, c.env, doc.id, doc.currentVersion));
  if (!doc || !opened) return c.json(GONE, 404);
  const asAttachment = download && link.allowDownload;
  await logVisit(c, link, asAttachment ? "download" : "read-content", 200);
  return new Response(opened.object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(opened.object.size),
      "content-disposition": disposition(asAttachment ? "attachment" : "inline", doc.title),
    },
  });
});

sharedRoutes.post("/:token/unlock", async (c) => {
  const link = await openLink(c, "unlock");
  if (link instanceof Response) return link;
  if (link.passwordHash === null) return c.body(null, 204);
  if (!(await unlockAttemptAllowed(c.env, link.linkId))) {
    await logVisit(c, link, "unlock", 429);
    throw new AppError("rate_limited", "Too many attempts. Try again in 10 minutes.");
  }
  const { password } = await parseJson(c.req.raw, ShareUnlock);
  if (!(await verifySharePassword(password, link.passwordHash))) {
    await logVisit(c, link, "unlock", 401);
    return c.json({ error: "unauthenticated", message: "That password is not right" }, 401);
  }
  const grant = await issueShareGrant(c.env, link, Date.now());
  setCookie(c, GRANT_COOKIE, grant.value, {
    path: `/api/share/${c.req.param("token")}`,
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Strict",
    maxAge: grant.maxAgeSeconds,
  });
  await logVisit(c, link, "unlock", 200);
  return c.body(null, 204);
});

sharedRoutes.all("*", (c) => c.json(GONE, 404));
