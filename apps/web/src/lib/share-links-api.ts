// Share links over the API (T2.3): Members manage them, visitors open them signed out.
import {
  ErrorResponse,
  SharedDocument,
  ShareLinkCreatedResponse,
  ShareLinkListResponse,
  ShareLinkResponse,
  type ShareLinkInfo,
} from "@inkly/domain";
import type { z } from "zod";

import { ApiError } from "./api.ts";

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
  const res = await fetch(path, { ...init, credentials: "same-origin" });
  if (!res.ok) throw await failure(res);
  return schema.parse(await res.json());
}

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export interface NewShareLink {
  readonly documentId: string;
  readonly expiresAt: number | null;
  readonly password: string | null;
  readonly allowDownload: boolean;
}

const sharePath = (token: string) => `/api/share/${encodeURIComponent(token)}`;

export const shareLinksApi = {
  list: async (documentId?: string): Promise<ShareLinkInfo[]> =>
    (
      await call(
        ShareLinkListResponse,
        documentId
          ? `/api/share-links?documentId=${encodeURIComponent(documentId)}`
          : "/api/share-links",
      )
    ).links,
  create: (link: NewShareLink) => call(ShareLinkCreatedResponse, "/api/share-links", post(link)),
  revoke: async (id: string): Promise<ShareLinkInfo> =>
    (await call(ShareLinkResponse, `/api/share-links/${id}/revoke`, { method: "POST" })).link,

  shared: (token: string) => call(SharedDocument, sharePath(token)),
  unlock: async (token: string, password: string): Promise<void> => {
    const res = await fetch(`${sharePath(token)}/unlock`, {
      ...post({ password }),
      credentials: "same-origin",
    });
    if (!res.ok) throw await failure(res);
  },
  content: async (token: string): Promise<ArrayBuffer> => {
    const res = await fetch(`${sharePath(token)}/content`, { credentials: "same-origin" });
    if (!res.ok) throw await failure(res);
    return res.arrayBuffer();
  },
  downloadUrl: (token: string) => `${sharePath(token)}/content?download=1`,
};
