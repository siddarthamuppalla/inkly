import type { MiddlewareHandler } from "hono";

import type { Env } from "./env.ts";
import { denyAccess, type TenantVars } from "./tenant-context.ts";

/** Lets every Member read; refuses a viewer's writes with a logged 403. */
export const viewersReadOnly: MiddlewareHandler<{ Bindings: Env; Variables: TenantVars }> = async (
  c,
  next,
) => {
  const reading = c.req.method === "GET" || c.req.method === "HEAD";
  if (!reading && c.get("session").role === "viewer") {
    return denyAccess(c, "write", `${c.req.method} ${c.req.path}`, 403);
  }
  await next();
};
