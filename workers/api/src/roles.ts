import type { Session } from "@inkly/auth";
import type { MiddlewareHandler } from "hono";

import type { Env } from "./env.ts";
import { denyAccess, type TenantVars } from "./tenant-context.ts";

export type Role = "owner" | "admin" | "editor" | "viewer";

/** The caller's Member role. Phase 0 sessions carry none and act as their Tenant's owner. */
export function roleOf(session: Session): Role {
  return (session as Session & { role?: Role }).role ?? "owner";
}

/** Lets every Member read; refuses a viewer's writes with a logged 403. */
export const viewersReadOnly: MiddlewareHandler<{ Bindings: Env; Variables: TenantVars }> = async (
  c,
  next,
) => {
  const reading = c.req.method === "GET" || c.req.method === "HEAD";
  if (!reading && roleOf(c.get("session")) === "viewer") {
    return denyAccess(c, "write", `${c.req.method} ${c.req.path}`, 403);
  }
  await next();
};
