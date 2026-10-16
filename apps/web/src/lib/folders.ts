import type { FolderInfo } from "@inkly/domain";

/** The folder and its ancestors, top level first. */
export function folderPath(folders: readonly FolderInfo[], id: string | null): FolderInfo[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: FolderInfo[] = [];
  let current = id === null ? undefined : byId.get(id);
  while (current && !path.includes(current)) {
    path.unshift(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path;
}

/** Every folder with its full path name ("Contracts / 2026"), sorted by that name. */
export function folderChoices(folders: readonly FolderInfo[]): { id: string; label: string }[] {
  return folders
    .map((f) => ({
      id: f.id,
      label: folderPath(folders, f.id)
        .map((p) => p.name)
        .join(" / "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
