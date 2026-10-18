import { D1Dialect } from "./auth-dialect.ts";
import type { StorageEnv } from "./env.ts";

export { D1Dialect };

// `@inkly/storage/auth`: the storage `packages/auth` needs before it has a TenantId:
// Better-Auth's own tables, membership lookups by user, the Outbox and KV counters.
// Lint (`no-restricted-imports`) keeps every other package out of this entry point.

/**
 * Better-Auth's database: its Kysely adapter over D1, which owns the auth tables, through
 * a dialect that does not queue every query behind one lock (see auth-dialect.ts, #72).
 */
export function authDatabase(env: StorageEnv): {
  dialect: D1Dialect;
  type: "sqlite";
  transaction: false;
} {
  return { dialect: new D1Dialect(env.DB), type: "sqlite", transaction: false };
}

export interface MembershipRow {
  tenantId: string;
  tenantName: string;
  plan: "free" | "pro";
  role: string;
}

const MEMBERSHIP_SELECT =
  "SELECT m.tenant_id AS tenantId, t.name AS tenantName, t.plan AS plan, m.role AS role FROM memberships m JOIN tenants t ON t.id = m.tenant_id";

/** The user's membership in one tenant, or null when they are not a Member. */
export async function findMembership(
  env: StorageEnv,
  userId: string,
  tenantId: string,
): Promise<MembershipRow | null> {
  return env.DB.prepare(`${MEMBERSHIP_SELECT} WHERE m.user_id = ?1 AND m.tenant_id = ?2`)
    .bind(userId, tenantId)
    .first<MembershipRow>();
}

/** Every tenant the user is a Member of, oldest membership first. */
export async function listMembershipsOfUser(
  env: StorageEnv,
  userId: string,
): Promise<MembershipRow[]> {
  const { results } = await env.DB.prepare(
    `${MEMBERSHIP_SELECT} WHERE m.user_id = ?1 ORDER BY m.created_at, m.id`,
  )
    .bind(userId)
    .all<MembershipRow>();
  return results;
}

export interface InvitationTarget {
  tenantId: string;
  plan: "free" | "pro";
  memberCount: number;
}

/** The tenant an invitation is for, its Plan and how many Members it has now. */
export async function findInvitationTarget(
  env: StorageEnv,
  invitationId: string,
): Promise<InvitationTarget | null> {
  return env.DB.prepare(
    "SELECT i.tenant_id AS tenantId, t.plan AS plan, (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = i.tenant_id) AS memberCount FROM invitations i JOIN tenants t ON t.id = i.tenant_id WHERE i.id = ?1",
  )
    .bind(invitationId)
    .first<InvitationTarget>();
}

export interface OutboxMail {
  to: string;
  subject: string;
  text: string;
}

export interface OutboxRow extends OutboxMail {
  id: number;
  createdAt: number;
}

export async function appendOutbox(env: StorageEnv, mail: OutboxMail): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO outbox (to_email, subject, text, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(mail.to.toLowerCase(), mail.subject, mail.text, Date.now())
    .run();
}

/** Captured mail for one address, newest first. */
export async function listOutbox(env: StorageEnv, to: string): Promise<OutboxRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, to_email AS "to", subject, text, created_at AS createdAt FROM outbox WHERE to_email = ?1 ORDER BY id DESC',
  )
    .bind(to.toLowerCase())
    .all<OutboxRow>();
  return results;
}

interface CounterWindow {
  count: number;
  resetAt: number;
}

/**
 * Counts one hit in a fixed window kept in KV and returns the count so far, this hit
 * included. KV is eventually consistent, so this is a soft limit across locations.
 */
export async function countWindowHit(
  env: StorageEnv,
  key: string,
  windowMs: number,
): Promise<number> {
  const kvKey = `ratelimit/${key}`;
  const now = Date.now();
  const current = await env.KV.get<CounterWindow>(kvKey, "json");
  const next: CounterWindow =
    current && current.resetAt > now
      ? { count: current.count + 1, resetAt: current.resetAt }
      : { count: 1, resetAt: now + windowMs };
  const ttlSeconds = Math.max(60, Math.ceil((next.resetAt - now) / 1000));
  await env.KV.put(kvKey, JSON.stringify(next), { expirationTtl: ttlSeconds });
  return next.count;
}

/** Only the non-secret expiry of this exact session and User. */
export async function findSessionExpiry(
  env: StorageEnv,
  sessionId: string,
  userId: string,
): Promise<number | string | null> {
  const row = await env.DB.prepare(
    "SELECT expires_at AS expiresAt FROM sessions WHERE id = ?1 AND user_id = ?2",
  )
    .bind(sessionId, userId)
    .first<{ expiresAt: number | string }>();
  return row?.expiresAt ?? null;
}

/** A Share link found by its token's sha256, before anything is known about its Tenant. */
export interface ShareLinkTarget {
  tenantId: string;
  linkId: string;
  documentId: string;
  expiresAt: number | null;
  revokedAt: number | null;
  passwordHash: string | null;
  allowDownload: number;
  documentDeletedAt: number | null;
}

export async function findShareLinkByTokenHash(
  env: StorageEnv,
  tokenHash: string,
): Promise<ShareLinkTarget | null> {
  return env.DB.prepare(
    `SELECT s.tenant_id AS tenantId, s.id AS linkId, s.document_id AS documentId,
       s.expires_at AS expiresAt, s.revoked_at AS revokedAt, s.password_hash AS passwordHash,
       s.allow_download AS allowDownload, d.deleted_at AS documentDeletedAt
     FROM share_links s JOIN documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id
     WHERE s.token_hash = ?1`,
  )
    .bind(tokenHash)
    .first<ShareLinkTarget>();
}
