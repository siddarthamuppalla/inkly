import { QueryClient, useQuery } from "@tanstack/react-query";

import { ApiError } from "./api.ts";
import { documentsApi } from "./documents-api.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // A 4xx will not change on retry; a dropped connection might.
      retry: (count, err) => !(err instanceof ApiError && err.status > 0) && count < 2,
    },
  },
});

export const keys = {
  documents: (folderId: string | null) => ["documents", folderId] as const,
  trash: ["trash"] as const,
  folders: ["folders"] as const,
  document: (id: string) => ["document", id] as const,
  versions: (id: string) => ["versions", id] as const,
  content: (id: string, version: number) => ["content", id, version] as const,
};

/** Every write can change lists, Trash, folders and Versions, so refetch them all. */
export function refreshAll(): Promise<void> {
  return queryClient.invalidateQueries();
}

export function useFolders(enabled: boolean) {
  return useQuery({ queryKey: keys.folders, queryFn: documentsApi.folders, enabled });
}
