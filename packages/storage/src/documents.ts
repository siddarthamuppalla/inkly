import type { DocumentId, FolderId, JobId, TenantId, UserId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";
import { versionKey } from "./keys.ts";
import { usageSnapshot } from "./usage.ts";
import {
  copyVersionObject,
  deleteVersionObject,
  getVersionObject,
  putVersionObject,
  type VersionObject,
} from "./versions.ts";

export interface DocumentRow {
  id: DocumentId;
  folderId: FolderId | null;
  title: string;
  currentVersion: number;
  pages: number;
  bytes: number;
  sha256: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface VersionRow {
  n: number;
  sha256: string;
  bytes: number;
  pages: number;
  createdBy: UserId;
  createdAt: number;
}

/** A new Version's bytes and what the caller learned from them. */
export interface NewVersion {
  body: Uint8Array;
  sha256: string;
  pages: number;
  createdBy: UserId;
}

const DOCUMENT_SELECT = `SELECT d.id, d.folder_id AS folderId, d.title, d.current_version AS currentVersion,
  v.pages, v.bytes, v.sha256, d.created_at AS createdAt, d.updated_at AS updatedAt, d.deleted_at AS deletedAt
  FROM documents d JOIN document_versions v
  ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.n = d.current_version`;

const VERSION_SELECT = `SELECT n, sha256, bytes, pages, created_by AS createdBy, created_at AS createdAt
  FROM document_versions`;

/** A Job's claim on adding a Version: it holds only while `attempt` still owns the commit. */
export interface JobCommit {
  jobId: JobId;
  attempt: number;
}

const COMMIT_OWNED = `EXISTS (SELECT 1 FROM jobs WHERE tenant_id = ?1 AND id = ?10
  AND status = 'committing' AND attempts = ?11)`;

function insertVersion(
  env: StorageEnv,
  tenantId: TenantId,
  documentId: DocumentId,
  n: number,
  v: Omit<VersionRow, "n" | "createdAt">,
  now: number,
  commit?: JobCommit,
): D1PreparedStatement {
  const stmt = env.DB.prepare(
    `INSERT INTO document_versions (tenant_id, document_id, n, r2_key, sha256, bytes, pages, created_by, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${commit ? COMMIT_OWNED : "1"}`,
  );
  const values = [
    tenantId,
    documentId,
    n,
    versionKey(tenantId, documentId, n),
    v.sha256,
    v.bytes,
    v.pages,
    v.createdBy,
    now,
  ];
  return commit ? stmt.bind(...values, commit.jobId, commit.attempt) : stmt.bind(...values);
}

/** Stores Version 1's bytes, then records the Document and Version. */
export async function createDocument(
  tenantId: TenantId,
  env: StorageEnv,
  doc: { id: DocumentId; title: string; folderId: FolderId | null },
  version: NewVersion,
): Promise<DocumentRow> {
  await putVersionObject(tenantId, env, doc.id, 1, version.body, version.sha256);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents (tenant_id, id, folder_id, title, current_version, last_version, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?6, ?6)`,
      ).bind(tenantId, doc.id, doc.folderId, doc.title, version.createdBy, now),
      insertVersion(env, tenantId, doc.id, 1, { ...version, bytes: version.body.byteLength }, now),
      usageSnapshot(env, tenantId, now),
    ]);
  } catch (err) {
    await deleteVersionObject(tenantId, env, doc.id, 1);
    throw err;
  }
  const row = await getDocument(tenantId, env, doc.id);
  if (!row) throw new Error("document vanished after insert");
  return row;
}

export async function getDocument(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
): Promise<DocumentRow | null> {
  return env.DB.prepare(`${DOCUMENT_SELECT} WHERE d.tenant_id = ?1 AND d.id = ?2`)
    .bind(tenantId, id)
    .first<DocumentRow>();
}

/** Documents in one folder (null = top level), or in Trash; newest first. */
export async function listDocuments(
  tenantId: TenantId,
  env: StorageEnv,
  where: { folderId: FolderId | null } | "trash",
): Promise<DocumentRow[]> {
  const query =
    where === "trash"
      ? env.DB.prepare(
          `${DOCUMENT_SELECT} WHERE d.tenant_id = ?1 AND d.deleted_at IS NOT NULL ORDER BY d.deleted_at DESC`,
        ).bind(tenantId)
      : env.DB.prepare(
          `${DOCUMENT_SELECT} WHERE d.tenant_id = ?1 AND d.deleted_at IS NULL AND d.folder_id IS ?2
           ORDER BY d.updated_at DESC, d.created_at DESC`,
        ).bind(tenantId, where.folderId);
  return (await query.all<DocumentRow>()).results;
}

/** Renames and/or moves a Document. Returns null when the Tenant has no such Document. */
export async function updateDocument(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  patch: { title?: string | undefined; folderId?: FolderId | null | undefined },
): Promise<DocumentRow | null> {
  const res = await env.DB.prepare(
    `UPDATE documents SET
       title = CASE WHEN ?3 THEN ?4 ELSE title END,
       folder_id = CASE WHEN ?5 THEN ?6 ELSE folder_id END,
       updated_at = ?7
     WHERE tenant_id = ?1 AND id = ?2`,
  )
    .bind(
      tenantId,
      id,
      patch.title !== undefined ? 1 : 0,
      patch.title ?? null,
      patch.folderId !== undefined ? 1 : 0,
      patch.folderId ?? null,
      Date.now(),
    )
    .run();
  return res.meta.changes > 0 ? getDocument(tenantId, env, id) : null;
}

/** Moves a Document to Trash (true) or back out of it (false). Returns false when it doesn't exist. */
export async function setTrashed(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  trashed: boolean,
): Promise<boolean> {
  const res = await env.DB.prepare(
    "UPDATE documents SET deleted_at = CASE WHEN ?3 THEN COALESCE(deleted_at, ?4) END WHERE tenant_id = ?1 AND id = ?2",
  )
    .bind(tenantId, id, trashed ? 1 : 0, Date.now())
    .run();
  return res.meta.changes > 0;
}

/** All Versions of a Document, newest first. */
export async function listVersions(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
): Promise<VersionRow[]> {
  const { results } = await env.DB.prepare(
    `${VERSION_SELECT} WHERE tenant_id = ?1 AND document_id = ?2 ORDER BY n DESC`,
  )
    .bind(tenantId, id)
    .all<VersionRow>();
  return results;
}

export async function getVersion(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  n: number,
): Promise<VersionRow | null> {
  return env.DB.prepare(`${VERSION_SELECT} WHERE tenant_id = ?1 AND document_id = ?2 AND n = ?3`)
    .bind(tenantId, id, n)
    .first<VersionRow>();
}

/**
 * Claims the next Version number, writes its bytes with `write`, then records it and
 * makes it current. A failed write leaves a gap in the numbering, never a broken Version.
 * With `commit`, the Version is recorded only while that Job attempt still owns its commit;
 * otherwise its bytes are deleted and the result is null.
 */
async function appendVersion(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  meta: Omit<VersionRow, "n" | "createdAt">,
  write: (n: number) => Promise<void>,
  commit?: JobCommit,
): Promise<DocumentRow | null> {
  const claimed = await env.DB.prepare(
    "UPDATE documents SET last_version = last_version + 1 WHERE tenant_id = ?1 AND id = ?2 RETURNING last_version AS n",
  )
    .bind(tenantId, id)
    .first<{ n: number }>();
  if (!claimed) return null;
  await write(claimed.n);
  const now = Date.now();
  const makeCurrent = env.DB.prepare(
    `UPDATE documents SET current_version = MAX(current_version, ?3), updated_at = ?4
     WHERE tenant_id = ?1 AND id = ?2 AND EXISTS (SELECT 1 FROM document_versions
       WHERE tenant_id = ?1 AND document_id = ?2 AND n = ?3)`,
  ).bind(tenantId, id, claimed.n, now);
  const [inserted] = await env.DB.batch([
    insertVersion(env, tenantId, id, claimed.n, meta, now, commit),
    makeCurrent,
    usageSnapshot(env, tenantId, now),
  ]);
  if (inserted?.meta.changes === 0) {
    await deleteVersionObject(tenantId, env, id, claimed.n);
    return null;
  }
  return getDocument(tenantId, env, id);
}

/**
 * Adds uploaded bytes as the Document's new current Version. A Job passes its `commit`, so
 * a delivery that lost the Job to a newer one cannot add a second Version.
 */
export async function addVersion(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  version: NewVersion,
  commit?: JobCommit,
): Promise<DocumentRow | null> {
  const meta = { ...version, bytes: version.body.byteLength };
  return appendVersion(
    tenantId,
    env,
    id,
    meta,
    (n) => putVersionObject(tenantId, env, id, n, version.body, version.sha256),
    commit,
  );
}

/** Copies Version `from` into a new current Version. Null when the Document or Version is missing. */
export async function restoreVersion(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  from: number,
  createdBy: UserId,
): Promise<DocumentRow | null> {
  const source = await getVersion(tenantId, env, id, from);
  if (!source) return null;
  return appendVersion(tenantId, env, id, { ...source, createdBy }, async (n) => {
    if (!(await copyVersionObject(tenantId, env, id, from, n))) {
      throw new Error(`R2 object for version ${String(from)} is missing`);
    }
  });
}

/** A Version's metadata and a stream of its bytes; the current Version when `n` is omitted. */
export async function openVersion(
  tenantId: TenantId,
  env: StorageEnv,
  id: DocumentId,
  n?: number,
): Promise<{ version: VersionRow; object: VersionObject } | null> {
  let wanted = n;
  if (wanted === undefined) {
    const doc = await getDocument(tenantId, env, id);
    if (!doc) return null;
    wanted = doc.currentVersion;
  }
  const version = await getVersion(tenantId, env, id, wanted);
  if (!version) return null;
  const object = await getVersionObject(tenantId, env, id, wanted);
  return object ? { version, object } : null;
}
