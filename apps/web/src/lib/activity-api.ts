// Document and Share-link activity over the API (T2.4).
import { ActivityResponse, ErrorResponse } from "@inkly/domain";

import { ApiError } from "./api.ts";

async function page(path: string, before: number | null): Promise<ActivityResponse> {
  const url = before === null ? path : `${path}?before=${String(before)}`;
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    const body = ErrorResponse.safeParse(await res.json().catch(() => null));
    throw new ApiError(
      res.status,
      body.success ? body.data.error : "error",
      body.success ? (body.data.message ?? body.data.error) : res.statusText,
    );
  }
  return ActivityResponse.parse(await res.json());
}

export const activityApi = {
  document: (id: string, before: number | null) =>
    page(`/api/documents/${encodeURIComponent(id)}/activity`, before),
  shareLink: (id: string, before: number | null) =>
    page(`/api/share-links/${encodeURIComponent(id)}/activity`, before),
};
