import { AppError, isWellFormedId, type TenantId, type UserId } from "@inkly/domain";
import { listAccessLog, setTenantPlan, type AccessLogRow, type Plan } from "@inkly/storage";
import { listMembershipsOfUser } from "@inkly/storage/auth";

import { getAuth } from "./better-auth.ts";
import type { AuthEnv } from "./env.ts";

export interface SeededAccount {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly email: string;
  /** Session token for `Authorization: Bearer`. */
  readonly token: string;
}

/** Test hooks only (Q11): a tenant's access log, for verify-tenancy to count its denials. */
export async function readAccessLog(env: AuthEnv, tenant: string): Promise<AccessLogRow[] | null> {
  return isWellFormedId(tenant) ? listAccessLog(tenant as TenantId, env) : null;
}

/**
 * Test hooks only (Q11): creates a User the way sign-up does (so they get their own
 * workspace as owner) and a session, without the email round trip.
 */
export async function seedAccount(
  request: Request,
  env: AuthEnv,
  input: { email: string; name: string; plan?: Plan },
): Promise<SeededAccount> {
  const ctx = await getAuth(env, request.url).$context;
  const user = await ctx.internalAdapter.createUser(
    { email: input.email.toLowerCase(), name: input.name, emailVerified: true },
    { method: "test-hooks" },
  );
  const session = await ctx.internalAdapter.createSession(user.id);
  const [membership] = await listMembershipsOfUser(env, user.id);
  if (!membership) throw new AppError("internal", "sign-up did not create a workspace");
  const tenantId = membership.tenantId as TenantId;
  if (input.plan) await setTenantPlan(tenantId, env, input.plan);
  return { tenantId, userId: user.id as UserId, email: user.email, token: session.token };
}
