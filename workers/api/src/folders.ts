import { AppError, FolderCreate, FolderPatch, isWellFormedId, type FolderId } from "@inkly/domain";
import { createFolder, deleteFolder, getFolder, listFolders, updateFolder } from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";

// Mounted at /api/folders behind requireTenant.
export const folderRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

folderRoutes.use("*", viewersReadOnly);

function missing(c: TenantContext): Promise<Response> {
  return denyAccess(c, "write", `${c.req.method} ${c.req.path}`, 404);
}

/** True when `raw` is null (top level) or names one of the Tenant's folders. */
async function isFolderOrTop(c: TenantContext, raw: string | null): Promise<boolean> {
  if (raw === null) return true;
  return (
    isWellFormedId(raw) && (await getFolder(c.get("tenantId"), c.env, raw as FolderId)) !== null
  );
}

function folderParam(c: TenantContext): FolderId | null {
  const id = c.req.param("id") ?? "";
  return isWellFormedId(id) ? (id as FolderId) : null;
}

folderRoutes.get("/", async (c) =>
  c.json({ folders: await listFolders(c.get("tenantId"), c.env) }),
);

folderRoutes.post("/", async (c) => {
  const body = await parseJson(c.req.raw, FolderCreate);
  if (!(await isFolderOrTop(c, body.parentId))) return missing(c);
  const folder = await createFolder(c.get("tenantId"), c.env, {
    name: body.name,
    parentId: body.parentId as FolderId | null,
  });
  return c.json({ folder }, 201);
});

folderRoutes.patch("/:id", async (c) => {
  const patch = await parseJson(c.req.raw, FolderPatch);
  const id = folderParam(c);
  if (id === null) return missing(c);
  if (patch.parentId !== undefined && !(await isFolderOrTop(c, patch.parentId))) return missing(c);
  const folder = await updateFolder(c.get("tenantId"), c.env, id, {
    name: patch.name,
    parentId: patch.parentId as FolderId | null | undefined,
  });
  return folder ? c.json({ folder }) : missing(c);
});

folderRoutes.delete("/:id", async (c) => {
  const id = folderParam(c);
  const result = id === null ? "missing" : await deleteFolder(c.get("tenantId"), c.env, id);
  if (result === "missing") return missing(c);
  if (result === "not_empty") {
    throw new AppError(
      "conflict",
      "Only empty folders can be deleted. Move or delete what is inside first.",
    );
  }
  return c.body(null, 204);
});
