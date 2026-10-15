import {
  acceptInvitation,
  describeMe,
  googleConfigured,
  handleAuthRequest,
  inviteMember,
  removeMember,
  switchTenant,
} from "@inkly/auth";
import { listMembers, listPendingInvitations } from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import {
  denyAccess,
  requireTenant,
  type TenantContext,
  type TenantVars,
} from "./tenant-context.ts";

// T1.1: sign-in (Better-Auth at /api/auth/*), the signed-in User, Tenant switching
// and Members. Mounted at /api.

export const account = new Hono<{ Bindings: Env; Variables: TenantVars }>();

account.get("/auth-options", (c) => c.json({ google: googleConfigured(c.env) }));

account.on(["GET", "POST"], "/auth/*", (c) => handleAuthRequest(c.req.raw, c.env));

account.get("/me", async (c) => {
  const me = await describeMe(c.req.raw, c.env);
  return me ? c.json(me) : c.json({ error: "unauthenticated" }, 401);
});

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json().catch(() => null);
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** The caller, acting on the tenant `requireTenant` resolved. */
function actor(c: TenantContext) {
  return { ...c.get("session"), tenantId: c.get("tenantId") };
}

account.post("/me/active-tenant", requireTenant, async (c) => {
  const { tenantId } = await readJson(c.req.raw);
  const requested = typeof tenantId === "string" ? tenantId : "";
  if (!(await switchTenant(c.req.raw, c.env, c.get("session"), requested))) {
    return denyAccess(c, "write", `active-tenant ${requested}`, 403);
  }
  return c.json({ tenantId: requested });
});

account.get("/tenant/members", requireTenant, async (c) => {
  const tenantId = c.get("tenantId");
  const [members, invitations] = await Promise.all([
    listMembers(tenantId, c.env),
    listPendingInvitations(tenantId, c.env),
  ]);
  return c.json({ members, invitations });
});

account.post("/tenant/invitations", requireTenant, async (c) => {
  const { email, role } = await readJson(c.req.raw);
  return c.json(await inviteMember(c.req.raw, c.env, actor(c), { email, role }), 201);
});

account.delete("/tenant/members/:userId", requireTenant, async (c) => {
  await removeMember(c.req.raw, c.env, actor(c), c.req.param("userId"));
  return c.body(null, 204);
});

account.post("/invitations/:id/accept", async (c) => {
  return c.json(await acceptInvitation(c.req.raw, c.env, c.req.param("id")));
});
