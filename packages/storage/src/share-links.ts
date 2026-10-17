import type { DocumentId, ShareLinkId, TenantId, UserId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

// T2.3 Share links. Lookups by token happen before a TenantId exists, so they live in
// `@inkly/storage/auth` (findShareLinkByTokenHash) for packages/auth alone.

export interface ShareLinkRow {
  id: ShareLinkId;
  documentId: DocumentId;
  documentTitle: string;
  createdBy: UserId;
  createdAt: number;
  expiresAt: number | null;
  hasPassword: boolean;
  allowDownload: boolean;
  revokedAt: number | null;
  /** Granted opens of the link page, from the access log. */
  opens: number;
  lastOpenedAt: number | null;
}

export interface NewShareLink {
  id: ShareLinkId;
  documentId: DocumentId;
  tokenHash: string;
  createdBy: UserId;
  expiresAt: number | null;
  passwordHash: string | null;
  allowDownload: boolean;
}

type RawRow = Omit<ShareLinkRow, "hasPassword" | "allowDownload"> & {
  hasPassword: number;
  allowDownload: number;
};

const SELECT = `SELECT s.id, s.document_id AS documentId, d.title AS documentTitle,
  s.created_by AS createdBy, s.created_at AS createdAt, s.expires_at AS expiresAt,
  s.password_hash IS NOT NULL AS hasPassword, s.allow_download AS allowDownload,
  s.revoked_at AS revokedAt,
  (SELECT COUNT(*) FROM access_log l WHERE l.tenant_id = s.tenant_id AND l.share_link_id = s.id
     AND l.action = 'read' AND l.status = 200) AS opens,
  (SELECT MAX(l.at) FROM access_log l WHERE l.tenant_id = s.tenant_id AND l.share_link_id = s.id
     AND l.action = 'read' AND l.status = 200) AS lastOpenedAt
  FROM share_links s JOIN documents d ON d.tenant_id = s.tenant_id AND d.id = s.document_id`;

function toRow(raw: RawRow): ShareLinkRow {
  return { ...raw, hasPassword: raw.hasPassword === 1, allowDownload: raw.allowDownload === 1 };
}

export async function createShareLink(
  tenantId: TenantId,
  env: StorageEnv,
  link: NewShareLink,
): Promise<ShareLinkRow> {
  await env.DB.prepare(
    `INSERT INTO share_links (tenant_id, id, document_id, token_hash, created_by, created_at, expires_at, password_hash, allow_download)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      tenantId,
      link.id,
      link.documentId,
      link.tokenHash,
      link.createdBy,
      Date.now(),
      link.expiresAt,
      link.passwordHash,
      link.allowDownload ? 1 : 0,
    )
    .run();
  const row = await getShareLink(tenantId, env, link.id);
  if (!row) throw new Error("share link vanished after insert");
  return row;
}

export async function getShareLink(
  tenantId: TenantId,
  env: StorageEnv,
  id: ShareLinkId,
): Promise<ShareLinkRow | null> {
  const raw = await env.DB.prepare(`${SELECT} WHERE s.tenant_id = ?1 AND s.id = ?2`)
    .bind(tenantId, id)
    .first<RawRow>();
  return raw ? toRow(raw) : null;
}

/** The Tenant's links, or one Document's; newest first. */
export async function listShareLinks(
  tenantId: TenantId,
  env: StorageEnv,
  where: { documentId?: DocumentId } = {},
): Promise<ShareLinkRow[]> {
  const query =
    where.documentId === undefined
      ? env.DB.prepare(`${SELECT} WHERE s.tenant_id = ?1 ORDER BY s.created_at DESC, s.id`).bind(
          tenantId,
        )
      : env.DB.prepare(
          `${SELECT} WHERE s.tenant_id = ?1 AND s.document_id = ?2 ORDER BY s.created_at DESC, s.id`,
        ).bind(tenantId, where.documentId);
  return (await query.all<RawRow>()).results.map(toRow);
}

/** Revokes a link (idempotent: the first revocation time stays). Null when it doesn't exist. */
export async function revokeShareLink(
  tenantId: TenantId,
  env: StorageEnv,
  id: ShareLinkId,
): Promise<ShareLinkRow | null> {
  const res = await env.DB.prepare(
    "UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?3) WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, id, Date.now())
    .run();
  return res.meta.changes > 0 ? getShareLink(tenantId, env, id) : null;
}
