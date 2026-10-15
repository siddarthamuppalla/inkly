import type { TenantId, UserId } from "@inkly/domain";
import { findMembership, listMembershipsOfUser, type MembershipRow } from "@inkly/storage/auth";

import { getAuth } from "./better-auth.ts";
import { testHooksOn, type AuthEnv } from "./env.ts";

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Who is calling and the Active tenant they act within, after the membership check. */
export interface Session {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly role: Role;
}

export interface SignedInUser {
  readonly userId: UserId;
  readonly email: string;
  readonly name: string;
  /** The session's Active tenant as stored, before any membership check. */
  readonly activeTenantId: string | null;
}

/** The signed-in User from the session cookie or `Authorization: Bearer`, or null. */
export async function currentUser(request: Request, env: AuthEnv): Promise<SignedInUser | null> {
  const result = await getAuth(env, request.url).api.getSession({ headers: request.headers });
  if (!result) return null;
  return {
    userId: result.user.id as UserId,
    email: result.user.email,
    name: result.user.name,
    activeTenantId:
      (result.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  };
}

/**
 * The membership a request acts within: the session's Active tenant when the User is
 * still a Member of it, otherwise their oldest membership.
 */
export async function activeMembership(
  env: AuthEnv,
  user: SignedInUser,
): Promise<MembershipRow | null> {
  const active = user.activeTenantId
    ? await findMembership(env, user.userId, user.activeTenantId)
    : null;
  if (active) return active;
  const [first] = await listMembershipsOfUser(env, user.userId);
  return first ?? null;
}

export function sessionOf(user: SignedInUser, membership: MembershipRow): Session {
  return {
    userId: user.userId,
    tenantId: membership.tenantId as TenantId,
    role: isRole(membership.role) ? membership.role : "viewer",
  };
}

/** The caller's Session, or null when they are signed out or belong to no Tenant. */
export async function authenticate(request: Request, env: AuthEnv): Promise<Session | null> {
  const user = await currentUser(request, env);
  if (!user) return null;
  const membership = await activeMembership(env, user);
  return membership ? sessionOf(user, membership) : null;
}

export type TenantResolution = { ok: true; tenantId: TenantId } | { ok: false };

/**
 * The tenant a request acts on: always the session's Active tenant. A client that
 * names a different tenant (header or query) is refused, never trusted.
 */
export function resolveTenant(
  session: Session,
  requested: string | undefined,
  env: AuthEnv,
): TenantResolution {
  if (requested === undefined || requested === session.tenantId) {
    return { ok: true, tenantId: session.tenantId };
  }
  if (testHooksOn(env) && env.VERIFY_TENANCY_SELFTEST === "leak") {
    // Deliberate bug for `verify-tenancy --self-test`; unreachable without test hooks.
    return { ok: true, tenantId: requested as TenantId };
  }
  return { ok: false };
}
