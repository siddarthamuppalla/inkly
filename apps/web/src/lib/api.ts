import {
  DocumentListResponse,
  DocumentResponse,
  ErrorResponse,
  FolderListResponse,
  FolderResponse,
  VersionListResponse,
  type DocumentInfo,
  type FolderInfo,
  type VersionInfo,
} from "@inkly/domain";
import { z } from "zod";

/** A refused API call, with the server's message when it gave one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function failure(res: Response): Promise<ApiError> {
  const body = ErrorResponse.safeParse(await res.json().catch(() => null));
  const code = body.success ? body.data.error : "error";
  const message = body.success ? (body.data.message ?? code) : res.statusText;
  return new ApiError(res.status, code, message);
}

async function call<S extends z.ZodType>(
  schema: S,
  path: string,
  init: RequestInit = {},
): Promise<z.output<S>> {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (!res.ok) throw await failure(res);
  return schema.parse(await res.json());
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const Session = z.object({ signedIn: z.boolean() });

export const api = {
  session: () => call(Session, "/api/session"),

  documents: async (folderId: string | null): Promise<DocumentInfo[]> =>
    (
      await call(
        DocumentListResponse,
        folderId ? `/api/documents?folderId=${encodeURIComponent(folderId)}` : "/api/documents",
      )
    ).documents,
  trash: async (): Promise<DocumentInfo[]> =>
    (await call(DocumentListResponse, "/api/documents?trash=1")).documents,
  document: async (id: string): Promise<DocumentInfo> =>
    (await call(DocumentResponse, `/api/documents/${id}`)).document,
  versions: async (id: string): Promise<VersionInfo[]> =>
    (await call(VersionListResponse, `/api/documents/${id}/versions`)).versions,

  updateDocument: async (
    id: string,
    patch: { title?: string; folderId?: string | null },
  ): Promise<DocumentInfo> =>
    (await call(DocumentResponse, `/api/documents/${id}`, jsonInit("PATCH", patch))).document,
  trashDocument: async (id: string): Promise<DocumentInfo> =>
    (await call(DocumentResponse, `/api/documents/${id}`, { method: "DELETE" })).document,
  restoreDocument: async (id: string): Promise<DocumentInfo> =>
    (await call(DocumentResponse, `/api/documents/${id}/restore`, { method: "POST" })).document,
  restoreVersion: async (id: string, n: number): Promise<DocumentInfo> =>
    (
      await call(DocumentResponse, `/api/documents/${id}/versions/${String(n)}/restore`, {
        method: "POST",
      })
    ).document,

  folders: async (): Promise<FolderInfo[]> =>
    (await call(FolderListResponse, "/api/folders")).folders,
  createFolder: async (name: string, parentId: string | null): Promise<FolderInfo> =>
    (await call(FolderResponse, "/api/folders", jsonInit("POST", { name, parentId }))).folder,
  renameFolder: async (id: string, name: string): Promise<FolderInfo> =>
    (await call(FolderResponse, `/api/folders/${id}`, jsonInit("PATCH", { name }))).folder,
  deleteFolder: async (id: string): Promise<void> => {
    const res = await fetch(`/api/folders/${id}`, { method: "DELETE", credentials: "include" });
    if (!res.ok) throw await failure(res);
  },

  /** The current Version's bytes, or Version `n`'s. */
  content: async (id: string, n?: number): Promise<ArrayBuffer> => {
    const res = await fetch(contentUrl(id, n), { credentials: "include" });
    if (!res.ok) throw await failure(res);
    return res.arrayBuffer();
  },
};

function contentUrl(id: string, n?: number): string {
  return n === undefined
    ? `/api/documents/${id}/content`
    : `/api/documents/${id}/versions/${String(n)}/content`;
}

/**
 * Uploads a PDF as a new Document (or as a new Version of `documentId`), reporting
 * progress as a fraction from 0 to 1. XHR because fetch cannot report upload progress.
 */
export function uploadPdf(
  file: File,
  target: { folderId: string | null } | { documentId: string },
  onProgress: (fraction: number) => void,
): Promise<DocumentInfo> {
  const url =
    "documentId" in target
      ? `/api/documents/${target.documentId}/versions`
      : `/api/documents?${new URLSearchParams({
          filename: file.name,
          ...(target.folderId ? { folderId: target.folderId } : {}),
        }).toString()}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/pdf");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => {
      reject(new ApiError(0, "network", "The upload failed. Check your connection and try again."));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON: fall through to the status text
      }
      if (xhr.status === 201) {
        resolve(DocumentResponse.parse(body).document);
        return;
      }
      const err = ErrorResponse.safeParse(body);
      reject(
        new ApiError(
          xhr.status,
          err.success ? err.data.error : "error",
          err.success ? (err.data.message ?? err.data.error) : xhr.statusText,
        ),
      );
    };
    xhr.send(file);
  });
}
