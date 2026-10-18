// Envelopes over the sender API (T3.1); the editor and status page are T3.2.
import {
  AuditTrailResponse,
  EnvelopeListResponse,
  EnvelopeResponse,
  type EnvelopeInfo,
  type EnvelopeStatus,
} from "@inkly/domain";

import { ApiError } from "./api.ts";
import type { Draft } from "./envelope-draft.ts";
import { toBody } from "./envelope-draft.ts";
import { call, jsonInit } from "./documents-api.ts";

export const envelopeKeys = {
  all: ["envelopes"] as const,
  list: (status: EnvelopeStatus | null) => ["envelopes", "list", status] as const,
  envelope: (id: string) => ["envelopes", "one", id] as const,
  audit: (id: string) => ["envelopes", "audit", id] as const,
  content: (id: string) => ["envelopes", "content", id] as const,
};

const path = (id: string) => `/api/envelopes/${encodeURIComponent(id)}`;

export const envelopesApi = {
  list: async (status: EnvelopeStatus | null): Promise<EnvelopeInfo[]> =>
    (
      await call(
        EnvelopeListResponse,
        status ? `/api/envelopes?status=${status}` : "/api/envelopes",
      )
    ).envelopes,
  create: (documentId: string) =>
    call(EnvelopeResponse, "/api/envelopes", jsonInit("POST", { documentId })),
  get: (id: string) => call(EnvelopeResponse, path(id)),
  save: (id: string, draft: Draft) =>
    call(EnvelopeResponse, path(id), jsonInit("PUT", toBody(draft))),
  remove: async (id: string): Promise<void> => {
    const res = await fetch(path(id), { method: "DELETE", credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, "error", "This draft could not be deleted.");
  },
  send: (id: string) => call(EnvelopeResponse, `${path(id)}/send`, { method: "POST" }),
  remind: (id: string) => call(EnvelopeResponse, `${path(id)}/remind`, { method: "POST" }),
  void: (id: string, reason: string) =>
    call(EnvelopeResponse, `${path(id)}/void`, jsonInit("POST", { reason })),
  audit: (id: string) => call(AuditTrailResponse, `${path(id)}/audit`),
  /** The pinned Version, or the sealed PDF once the Envelope is completed. */
  content: async (id: string): Promise<ArrayBuffer> => {
    const res = await fetch(`${path(id)}/content`, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, "error", "The PDF could not be loaded.");
    return res.arrayBuffer();
  },
};
