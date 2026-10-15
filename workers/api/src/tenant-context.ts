import { authenticate, resolveTenant, type Session } from "@inkly/auth";
import type { TenantId } from "@inkly/domain";
import { accessDenied, accessGranted, logEvent, type AccessAction } from "@inkly/domain/log";
import { appendAccessLog } from "@inkly/storage";
import type { Context, MiddlewareHandler } from "hono";

import type { Env } from "./env.ts";

// The one way an API route learns who is calling and which Tenant it acts on.
// Routes mount `requireTenant` and read c.get("session") / c.get("tenantId").

export type TenantVars = { session: Session; tenantId: TenantId };
export type TenantContext = Context<{ Bindings: Env; Variables: TenantVars }>;

/** Refuses a request, writing an access-log entry against the caller's own tenant. */
export async function denyAccess(
  c: TenantContext,
  action: AccessAction,
  resource: string,
  status: 403 | 404,
): Promise<Response> {
  const session = c.get("session");
  const entry = accessDenied({
    actorTenantId: session.tenantId,
    actorUserId: session.userId,
    action,
    resource,
    status,
  });
  logEvent(entry);
  await appendAccessLog(session.tenantId, c.env, entry);
  return Response.json({ error: status === 403 ? "forbidden" : "not found" }, { status });
}

function actionOf(method: string, path: string): AccessAction {
  if (method !== "GET") return "write";
  if (path.endsWith("/content")) return "read-content";
  return /\/[a-z-]+\/?$/.test(path) ? "list" : "read";
}

export const requireTenant: MiddlewareHandler<{ Bindings: Env; Variables: TenantVars }> = async (
  c,
  next,
) => {
  const session = await authenticate(c.req.raw, c.env);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("session", session);
  const requested = c.req.header("x-inkly-tenant") ?? c.req.query("tenant");
  const resolved = resolveTenant(session, requested, c.env);
  if (!resolved.ok) {
    return denyAccess(c, actionOf(c.req.method, c.req.path), `${c.req.method} ${c.req.path}`, 403);
  }
  c.set("tenantId", resolved.tenantId);
  await next();
};

/** Records an allowed access (e.g. every content read) in the caller's access log. */
export async function grantAccess(
  c: TenantContext,
  action: AccessAction,
  resource: string,
): Promise<void> {
  const session = c.get("session");
  const entry = accessGranted({
    actorTenantId: session.tenantId,
    actorUserId: session.userId,
    action,
    resource,
  });
  logEvent(entry);
  await appendAccessLog(session.tenantId, c.env, entry);
}
