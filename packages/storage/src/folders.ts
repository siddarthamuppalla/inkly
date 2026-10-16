import { AppError, type FolderId, type TenantId } from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

export interface FolderRow {
  id: FolderId;
  parentId: FolderId | null;
  name: string;
  createdAt: number;
}

const FOLDER_SELECT =
  "SELECT id, parent_id AS parentId, name, created_at AS createdAt FROM folders";

export async function listFolders(tenantId: TenantId, env: StorageEnv): Promise<FolderRow[]> {
  const { results } = await env.DB.prepare(
    `${FOLDER_SELECT} WHERE tenant_id = ?1 ORDER BY name COLLATE NOCASE, created_at`,
  )
    .bind(tenantId)
    .all<FolderRow>();
  return results;
}

export async function getFolder(
  tenantId: TenantId,
  env: StorageEnv,
  id: FolderId,
): Promise<FolderRow | null> {
  return env.DB.prepare(`${FOLDER_SELECT} WHERE tenant_id = ?1 AND id = ?2`)
    .bind(tenantId, id)
    .first<FolderRow>();
}

/** Creates a folder; the caller has checked that `parentId` (if any) is the Tenant's. */
export async function createFolder(
  tenantId: TenantId,
  env: StorageEnv,
  folder: { name: string; parentId: FolderId | null },
): Promise<FolderRow> {
  const row: FolderRow = {
    id: `fld_${crypto.randomUUID().replaceAll("-", "")}` as FolderId,
    parentId: folder.parentId,
    name: folder.name,
    createdAt: Date.now(),
  };
  await env.DB.prepare(
    "INSERT INTO folders (tenant_id, id, parent_id, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(tenantId, row.id, row.parentId, row.name, row.createdAt)
    .run();
  return row;
}

/** True when `candidate` is `folder` itself or lies anywhere inside it. */
async function isWithin(
  tenantId: TenantId,
  env: StorageEnv,
  candidate: FolderId,
  folder: FolderId,
): Promise<boolean> {
  const hit = await env.DB.prepare(
    `WITH RECURSIVE up(id) AS (
       SELECT ?2
       UNION SELECT f.parent_id FROM folders f JOIN up ON f.id = up.id
       WHERE f.tenant_id = ?1 AND f.parent_id IS NOT NULL
     ) SELECT 1 AS hit FROM up WHERE id = ?3`,
  )
    .bind(tenantId, candidate, folder)
    .first<{ hit: number }>();
  return hit !== null;
}

/** Renames and/or re-parents a folder. Refuses to move a folder inside itself. */
export async function updateFolder(
  tenantId: TenantId,
  env: StorageEnv,
  id: FolderId,
  patch: { name?: string | undefined; parentId?: FolderId | null | undefined },
): Promise<FolderRow | null> {
  if (patch.parentId != null && (await isWithin(tenantId, env, patch.parentId, id))) {
    throw new AppError("conflict", "A folder cannot be moved inside itself");
  }
  const res = await env.DB.prepare(
    `UPDATE folders SET
       name = CASE WHEN ?3 THEN ?4 ELSE name END,
       parent_id = CASE WHEN ?5 THEN ?6 ELSE parent_id END
     WHERE tenant_id = ?1 AND id = ?2`,
  )
    .bind(
      tenantId,
      id,
      patch.name !== undefined ? 1 : 0,
      patch.name ?? null,
      patch.parentId !== undefined ? 1 : 0,
      patch.parentId ?? null,
    )
    .run();
  return res.meta.changes > 0 ? getFolder(tenantId, env, id) : null;
}

/**
 * Deletes a folder that holds no folders and no Documents outside Trash. Trashed
 * Documents in it move to the top level, so restoring them still works.
 */
export async function deleteFolder(
  tenantId: TenantId,
  env: StorageEnv,
  id: FolderId,
): Promise<"deleted" | "missing" | "not_empty"> {
  const [, deleted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE documents SET folder_id = NULL WHERE tenant_id = ?1 AND folder_id = ?2 AND deleted_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM folders WHERE tenant_id = ?1 AND parent_id = ?2)
       AND NOT EXISTS (SELECT 1 FROM documents WHERE tenant_id = ?1 AND folder_id = ?2 AND deleted_at IS NULL)`,
    ).bind(tenantId, id),
    env.DB.prepare(
      `DELETE FROM folders WHERE tenant_id = ?1 AND id = ?2
       AND NOT EXISTS (SELECT 1 FROM folders WHERE tenant_id = ?1 AND parent_id = ?2)
       AND NOT EXISTS (SELECT 1 FROM documents WHERE tenant_id = ?1 AND folder_id = ?2)`,
    ).bind(tenantId, id),
  ]);
  if ((deleted?.meta.changes ?? 0) > 0) return "deleted";
  return (await getFolder(tenantId, env, id)) ? "not_empty" : "missing";
}
