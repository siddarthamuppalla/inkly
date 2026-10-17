// Page ops over the API (T1.3b): edits add a Version; merge and split add Documents.
import {
  DocumentInfo,
  DocumentResponse,
  type DeletePagesRequest,
  type MergeRequest,
  type ReorderRequest,
  type RotateRequest,
  type SplitRequest,
} from "@inkly/domain";
import { z } from "zod";

import { call, jsonInit } from "./documents-api.ts";

const DocumentsResponse = z.object({ documents: z.array(DocumentInfo) });

const edit = async (id: string, op: string, body: unknown): Promise<DocumentInfo> =>
  (await call(DocumentResponse, `/api/documents/${id}/${op}`, jsonInit("POST", body))).document;

export const pageOpsApi = {
  rotate: (id: string, req: RotateRequest) => edit(id, "rotate", req),
  reorder: (id: string, req: ReorderRequest) => edit(id, "reorder", req),
  deletePages: (id: string, req: DeletePagesRequest) => edit(id, "delete-pages", req),
  merge: async (req: MergeRequest): Promise<DocumentInfo> =>
    (await call(DocumentResponse, "/api/documents/merge", jsonInit("POST", req))).document,
  split: async (id: string, req: SplitRequest): Promise<DocumentInfo[]> =>
    (await call(DocumentsResponse, `/api/documents/${id}/split`, jsonInit("POST", req))).documents,
};
