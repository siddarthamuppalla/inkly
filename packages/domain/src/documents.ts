import { z } from "zod";

// Request and response shapes shared by workers/api and apps/web.

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Title = z.string().trim().min(1).max(200);
const FolderName = z.string().trim().min(1).max(100);

export const DocumentPatch = z
  .object({ title: Title.optional(), folderId: Id.nullable().optional() })
  .refine((p) => p.title !== undefined || p.folderId !== undefined, "nothing to change");
export type DocumentPatch = z.infer<typeof DocumentPatch>;

export const FolderCreate = z.object({ name: FolderName, parentId: Id.nullable().default(null) });
export type FolderCreate = z.infer<typeof FolderCreate>;

export const FolderPatch = z
  .object({ name: FolderName.optional(), parentId: Id.nullable().optional() })
  .refine((p) => p.name !== undefined || p.parentId !== undefined, "nothing to change");
export type FolderPatch = z.infer<typeof FolderPatch>;

export const DocumentInfo = z.object({
  id: z.string(),
  folderId: z.string().nullable(),
  title: z.string(),
  currentVersion: z.number().int(),
  pages: z.number().int(),
  bytes: z.number().int(),
  sha256: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
});
export type DocumentInfo = z.infer<typeof DocumentInfo>;

export const VersionInfo = z.object({
  n: z.number().int(),
  sha256: z.string(),
  bytes: z.number().int(),
  pages: z.number().int(),
  createdAt: z.number(),
});
export type VersionInfo = z.infer<typeof VersionInfo>;

export const FolderInfo = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  createdAt: z.number(),
});
export type FolderInfo = z.infer<typeof FolderInfo>;

export const DocumentResponse = z.object({ document: DocumentInfo });
export const DocumentListResponse = z.object({ documents: z.array(DocumentInfo) });
export const VersionListResponse = z.object({ versions: z.array(VersionInfo) });
export const FolderResponse = z.object({ folder: FolderInfo });
export const FolderListResponse = z.object({ folders: z.array(FolderInfo) });
export const ErrorResponse = z.object({ error: z.string(), message: z.string().optional() });

/** A Document's title from an uploaded file name: the name without its `.pdf` extension. */
export function titleFromFilename(filename: string | undefined): string {
  const title = (filename ?? "")
    .replace(/\.pdf$/i, "")
    .trim()
    .slice(0, 200);
  return title === "" ? "Untitled" : title;
}
