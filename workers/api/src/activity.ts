import { activityAction, isWellFormedId, type ActivityEntry, type DocumentId } from "@inkly/domain";
import { getDocument, listActivity, type ActivityRow } from "@inkly/storage";
import { Hono, type MiddlewareHandler } from "hono";

import type { Env } from "./env.ts";
import {
  denyAccess,
  documentInPath,
  grantAccess,
  type TenantContext,
  type TenantVars,
} from "./tenant-context.ts";

// T2.4: a Document's activity from the access log, and the "edited" entries that feed it.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Logs every successful write to `/api/documents/:id/...` as an edit of that Document. */
export const recordDocumentEdits: MiddlewareHandler<{
  Bindings: Env;
  Variables: TenantVars;
}> = async (c, next) => {
  await next();
  const writing = c.req.method !== "GET" && c.req.method !== "HEAD";
  if (writing && c.res.ok && documentInPath(c.req.path) !== null) {
    await grantAccess(c, "write", `${c.req.method} ${c.req.path}`);
  }
};

/** Parses `?before=&limit=`; anything malformed falls back to the first page. */
export function pageOf(c: TenantContext): { before: number | null; limit: number } {
  const before = Number(c.req.query("before"));
  const limit = Number(c.req.query("limit"));
  return {
    before: Number.isSafeInteger(before) && before > 0 ? before : null,
    limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

/** Rows fetched with one extra beyond `limit`, as a page and the cursor for the next one. */
export function activityPage(
  rows: readonly ActivityRow[],
  limit: number,
): { entries: ActivityEntry[]; next: number | null } {
  const entries = rows.slice(0, limit).map((r): ActivityEntry => ({
    id: r.id,
    at: r.at,
    action: activityAction(r),
    actor:
      r.shareLinkId === null
        ? { kind: "member", userId: r.actorUserId, name: r.actorName ?? "Former member" }
        : { kind: "share-link", shareLinkId: r.shareLinkId },
    ip: r.ip,
    userAgent: r.userAgent,
  }));
  return { entries, next: rows.length > limit ? (entries.at(-1)?.id ?? null) : null };
}

/** Owners, admins and editors read activity; viewers get a logged 403. */
export function refuseViewers(c: TenantContext): Promise<Response> | null {
  return c.get("session").role === "viewer"
    ? denyAccess(c, "read", `${c.req.method} ${c.req.path}`, 403)
    : null;
}

// Mounted at /api/documents behind requireTenant.
export const activityRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

activityRoutes.get("/:id/activity", async (c) => {
  const refused = refuseViewers(c);
  if (refused) return refused;
  const tenantId = c.get("tenantId");
  const id = c.req.param("id");
  const doc = isWellFormedId(id) ? await getDocument(tenantId, c.env, id as DocumentId) : null;
  if (!doc) return denyAccess(c, "list", `${c.req.method} ${c.req.path}`, 404);
  const page = pageOf(c);
  const rows = await listActivity(
    tenantId,
    c.env,
    { documentId: doc.id },
    {
      before: page.before,
      limit: page.limit + 1,
    },
  );
  return c.json(activityPage(rows, page.limit));
});
