import { AppError, type TenantId } from "@inkly/domain";
import { getTenant, listMembers, listPendingInvitations, type Plan } from "@inkly/storage";
import { findInvitationTarget, findMembership, listMembershipsOfUser } from "@inkly/storage/auth";
import { isAPIError } from "better-auth/api";

import { getAuth } from "./better-auth.ts";
import type { AuthEnv } from "./env.ts";
import { memberLimit } from "./limits.ts";
import { activeMembership, currentUser, isRole, type Role, type Session } from "./session.ts";

// Workspace operations behind the API routes. Each one goes through Better-Auth's
// server API, so its organization rules still apply, and throws AppError for the
// outcomes clients match on.

const LIMIT_CODES = new Set(["ORGANIZATION_MEMBERSHIP_LIMIT_REACHED", "INVITATION_LIMIT_REACHED"]);

function toAppError(err: unknown): unknown {
  if (!isAPIError(err)) return err;
  const code = typeof err.body?.code === "string" ? err.body.code : "";
  const message = typeof err.body?.message === "string" ? err.body.message : err.message;
  if (LIMIT_CODES.has(code)) return new AppError("limit_exceeded", message);
  switch (err.statusCode) {
    case 400:
      return new AppError("invalid_input", message);
    case 401:
      return new AppError("unauthenticated", message);
    case 403:
      return new AppError("forbidden", message);
    case 404:
      return new AppError("not_found", message);
    default:
      return new AppError("internal", message);
  }
}

async function betterAuthCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw toAppError(err);
  }
}

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly plan: Plan;
  readonly role: string;
}

export interface Me {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly activeTenant: TenantSummary | null;
  readonly role: string | null;
  readonly tenants: readonly TenantSummary[];
}

const summary = (m: { tenantId: string; tenantName: string; plan: Plan; role: string }) => ({
  id: m.tenantId,
  name: m.tenantName,
  plan: m.plan,
  role: m.role,
});

/** The signed-in User, their Active tenant and role, and every Tenant they belong to. */
export async function describeMe(request: Request, env: AuthEnv): Promise<Me | null> {
  const user = await currentUser(request, env);
  if (!user) return null;
  const [active, all] = await Promise.all([
    activeMembership(env, user),
    listMembershipsOfUser(env, user.userId),
  ]);
  return {
    user: { id: user.userId, email: user.email, name: user.name },
    activeTenant: active ? summary(active) : null,
    role: active?.role ?? null,
    tenants: all.map(summary),
  };
}

/**
 * Makes `tenantId` the session's Active tenant. Returns false, changing nothing, when
 * the User is not a Member of it.
 */
export async function switchTenant(
  request: Request,
  env: AuthEnv,
  session: Session,
  tenantId: string,
): Promise<boolean> {
  if (!(await findMembership(env, session.userId, tenantId))) return false;
  await betterAuthCall(() =>
    getAuth(env, request.url).api.setActiveOrganization({
      headers: request.headers,
      body: { organizationId: tenantId },
    }),
  );
  return true;
}

const MANAGERS: readonly Role[] = ["owner", "admin"];
const INVITABLE: readonly Role[] = ["admin", "editor", "viewer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function seatsTaken(tenantId: TenantId, env: AuthEnv): Promise<number> {
  const [members, pending] = await Promise.all([
    listMembers(tenantId, env),
    listPendingInvitations(tenantId, env),
  ]);
  return members.length + pending.length;
}

/** Invites `email` to the Active tenant; refuses with `limit_exceeded` when every seat is taken. */
export async function inviteMember(
  request: Request,
  env: AuthEnv,
  session: Session,
  input: { email: unknown; role: unknown },
): Promise<{ id: string }> {
  if (!MANAGERS.includes(session.role)) {
    throw new AppError("forbidden", "Only owners and admins can invite members");
  }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email)) throw new AppError("invalid_input", "Enter a valid email address");
  const role = isRole(input.role) ? input.role : "editor";
  if (!INVITABLE.includes(role)) throw new AppError("invalid_input", `Cannot invite as ${role}`);
  const plan = (await getTenant(session.tenantId, env))?.plan ?? "free";
  const limit = memberLimit(plan);
  if ((await seatsTaken(session.tenantId, env)) >= limit) {
    throw new AppError(
      "limit_exceeded",
      `The ${plan === "pro" ? "Pro" : "Free"} plan allows ${String(limit)} member${limit === 1 ? "" : "s"}`,
    );
  }
  const invitation = await betterAuthCall(() =>
    getAuth(env, request.url).api.createInvitation({
      headers: request.headers,
      body: { email, role, organizationId: session.tenantId },
    }),
  );
  return { id: invitation.id };
}

/** Accepts an invitation for the signed-in User, who becomes a Member and switches to it. */
export async function acceptInvitation(
  request: Request,
  env: AuthEnv,
  invitationId: string,
): Promise<{ tenantId: string }> {
  const target = await findInvitationTarget(env, invitationId);
  if (!target) throw new AppError("not_found", "Invitation not found");
  if (target.memberCount >= memberLimit(target.plan)) {
    throw new AppError("limit_exceeded", "This workspace has no free member seats");
  }
  const auth = getAuth(env, request.url);
  await betterAuthCall(() =>
    auth.api.acceptInvitation({ headers: request.headers, body: { invitationId } }),
  );
  await betterAuthCall(() =>
    auth.api.setActiveOrganization({
      headers: request.headers,
      body: { organizationId: target.tenantId },
    }),
  );
  return { tenantId: target.tenantId };
}

/** Removes a Member from the Active tenant. Better-Auth refuses removing the last owner. */
export async function removeMember(
  request: Request,
  env: AuthEnv,
  session: Session,
  userId: string,
): Promise<void> {
  if (!MANAGERS.includes(session.role)) {
    throw new AppError("forbidden", "Only owners and admins can remove members");
  }
  if (userId === session.userId) throw new AppError("invalid_input", "You cannot remove yourself");
  const member = (await listMembers(session.tenantId, env)).find((m) => m.userId === userId);
  if (!member) throw new AppError("not_found", "Member not found");
  await betterAuthCall(() =>
    getAuth(env, request.url).api.removeMember({
      headers: request.headers,
      body: { memberIdOrEmail: member.email, organizationId: session.tenantId },
    }),
  );
}
