import type { TenantId, UserId } from "@inkly/domain";
import { createSession, findSession, type StorageEnv } from "@inkly/storage";

// Phase 0 bearer sessions, issued only by test seeding. Better-Auth replaces this
// in Phase 1 (ADR-0003); callers keep using authenticate() and resolveTenant().

export interface AuthEnv extends StorageEnv {
  TEST_HOOKS?: string;
  /** Self-test only: "leak" makes resolveTenant trust the client's tenant header. */
  VERIFY_TENANCY_SELFTEST?: string;
}

export interface Session {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueSession(
  tenantId: TenantId,
  userId: UserId,
  env: AuthEnv,
): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await createSession(tenantId, env, {
    tokenHash: await sha256Hex(token),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

/** The caller's session from `Authorization: Bearer <token>`, or null. */
export async function authenticate(
  authorization: string | undefined,
  env: AuthEnv,
): Promise<Session | null> {
  const token = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? "")?.[1];
  if (token === undefined) return null;
  const row = await findSession(env, await sha256Hex(token));
  return row ? { tenantId: row.tenantId, userId: row.userId } : null;
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
  if (env.TEST_HOOKS === "enabled" && env.VERIFY_TENANCY_SELFTEST === "leak") {
    // Deliberate bug for `verify-tenancy --self-test`; unreachable without test hooks.
    return { ok: true, tenantId: requested as TenantId };
  }
  return { ok: false };
}
