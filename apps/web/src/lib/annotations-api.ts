// Annotations, Comments and the DocSession live channel (T2.2).
import {
  AnnotationListResponse,
  AnnotationResponse,
  ErrorResponse,
  LiveMessage,
  type Annotation,
  type AnnotationPatch,
  type AnnotationShape,
  type Author,
} from "@inkly/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { z } from "zod";

import { ApiError } from "./api.ts";
import { keys, queryClient } from "./queries.ts";

export const annotationsKey = (documentId: string) => ["annotations", documentId] as const;

async function call<S extends z.ZodType>(
  schema: S,
  path: string,
  init: RequestInit = {},
): Promise<z.output<S>> {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (!res.ok) {
    const body = ErrorResponse.safeParse(await res.json().catch(() => null));
    throw new ApiError(
      res.status,
      body.success ? body.data.error : "error",
      body.success ? (body.data.message ?? body.data.error) : res.statusText,
    );
  }
  return schema.parse(await res.json());
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined && {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
});

/** Puts `annotation` into the cached list, replacing an older copy. */
function upsert(documentId: string, annotation: Annotation): void {
  queryClient.setQueryData<Annotation[]>(annotationsKey(documentId), (list = []) =>
    list.some((a) => a.id === annotation.id)
      ? list.map((a) => (a.id === annotation.id ? annotation : a))
      : [...list, annotation],
  );
}

function drop(documentId: string, id: string): void {
  queryClient.setQueryData<Annotation[]>(annotationsKey(documentId), (list = []) =>
    list.filter((a) => a.id !== id),
  );
}

export function annotationsApi(documentId: string) {
  const base = `/api/documents/${documentId}/annotations`;
  const saved = async (p: Promise<{ annotation: Annotation }>) => {
    const { annotation } = await p;
    upsert(documentId, annotation);
    return annotation;
  };
  return {
    list: async (signal?: AbortSignal) =>
      (await call(AnnotationListResponse, base, signal ? { signal } : {})).annotations,
    create: (shape: AnnotationShape) => saved(call(AnnotationResponse, base, send("POST", shape))),
    edit: (id: string, patch: AnnotationPatch) =>
      saved(call(AnnotationResponse, `${base}/${id}`, send("PATCH", patch))),
    remove: async (id: string) => {
      const res = await fetch(`${base}/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new ApiError(res.status, "error", "This annotation could not be deleted.");
      drop(documentId, id);
    },
    comment: (id: string, text: string) =>
      saved(call(AnnotationResponse, `${base}/${id}/comments`, send("POST", { text }))),
    resolve: (id: string, resolved: boolean) =>
      saved(
        call(AnnotationResponse, `${base}/${id}/${resolved ? "resolve" : "reopen"}`, send("POST")),
      ),
    /** The current Version with its Annotations drawn in as PDF annotations. */
    annotatedPdf: async (): Promise<Blob> => {
      const res = await fetch(`/api/documents/${documentId}/annotated-content`, {
        credentials: "include",
      });
      if (!res.ok) throw new ApiError(res.status, "error", "The download failed. Try again.");
      return res.blob();
    },
  };
}

/**
 * Marks the Document as on its way to Trash and aborts Annotation reads in flight: the API
 * answers 404 for a Trashed Document's Annotations.
 */
export async function leaveForTrash(doc: { id: string }): Promise<void> {
  queryClient.setQueryData<{ deletedAt: number | null }>(keys.document(doc.id), (d) =>
    d ? { ...d, deletedAt: Date.now() } : d,
  );
  await queryClient.cancelQueries({ queryKey: annotationsKey(doc.id) });
}

/** A Trashed Document has no Annotations to fetch; the API answers 404. */
function inTrash(documentId: string): boolean {
  const doc = queryClient.getQueryData<{ deletedAt: number | null }>(keys.document(documentId));
  return doc !== undefined && doc.deletedAt !== null;
}

export function useAnnotations(documentId: string) {
  return useQuery({
    queryKey: annotationsKey(documentId),
    queryFn: ({ signal }) => annotationsApi(documentId).list(signal),
    // Read at each (re)fetch, so a Document trashed a moment ago is not asked for again.
    enabled: () => !inTrash(documentId),
  });
}

const PING_MS = 30_000;
const MAX_BACKOFF_MS = 10_000;

/**
 * Keeps a WebSocket to the Document's DocSession open: changes from other viewers land in
 * the annotations cache, and `members` says who has the Document open right now.
 */
export function useDocSession(
  documentId: string,
  enabled: boolean,
): { members: Author[]; live: boolean } {
  const [members, setMembers] = useState<Author[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let stopped = false;

    function connect() {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${scheme}://${window.location.host}/api/documents/${documentId}/annotations/live`,
      );
      socket = ws;
      ws.onopen = () => {
        attempts = 0;
        setLive(true);
        // Changes made while disconnected are not replayed; refetch once on (re)connect.
        void queryClient.invalidateQueries({ queryKey: annotationsKey(documentId) });
        ping = setInterval(() => {
          ws.send("ping");
        }, PING_MS);
      };
      ws.onmessage = (e: MessageEvent<unknown>) => {
        if (typeof e.data !== "string" || e.data === "pong") return;
        const parsed = LiveMessage.safeParse(JSON.parse(e.data));
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "presence") setMembers(message.members);
        else if (message.type === "annotation") upsert(documentId, message.annotation);
        else drop(documentId, message.id);
      };
      ws.onclose = () => {
        clearInterval(ping);
        setLive(false);
        if (stopped) return;
        attempts += 1;
        retry = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempts));
      };
    }

    connect();
    return () => {
      stopped = true;
      clearInterval(ping);
      clearTimeout(retry);
      socket?.close(1000, "left the document");
    };
  }, [documentId, enabled]);

  return { members, live };
}
