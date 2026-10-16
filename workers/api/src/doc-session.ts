import { mayChangeAnnotation, type Role } from "@inkly/auth";
import {
  AnnotationShape,
  type Annotation,
  type AnnotationPatch,
  type Author,
  type Comment,
  type LiveMessage,
  type TenantId,
} from "@inkly/domain";
import type { DocumentRow } from "@inkly/storage";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

// DocSession (GLOSSARY): one per Document, named `{tenantId}/{documentId}`, the single
// writer of its Annotations and Comments. Only the API Worker holds the binding, and it
// calls in only after requireTenant and a Document lookup, so the DO trusts its Actor.

export interface Actor {
  readonly userId: string;
  readonly name: string;
  readonly role: Role;
}

export type Refusal = "not_found" | "forbidden" | "invalid_input";
export type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: Refusal };

/** The DocSession of `doc`. Taking the looked-up row keeps callers from skipping the lookup. */
export function docSession(env: Env, tenantId: TenantId, doc: DocumentRow) {
  return env.DOC_SESSIONS.get(env.DOC_SESSIONS.idFromName(`${tenantId}/${doc.id}`));
}

/** Header carrying the Actor on the WebSocket upgrade the API Worker forwards. */
export const ACTOR_HEADER = "x-inkly-actor";

interface AnnotationRow extends Record<string, SqlStorageValue> {
  id: string;
  shape: string;
  version: number;
  author_id: string;
  author_name: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

interface CommentRow extends Record<string, SqlStorageValue> {
  id: string;
  annotation_id: string;
  author_id: string;
  author_name: string;
  text: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  shape TEXT NOT NULL,
  version INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  annotation_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_annotation ON comments (annotation_id, created_at);
`;

const refuse = (reason: Refusal): Outcome<never> => ({ ok: false, reason });

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    author: { id: row.author_id, name: row.author_name },
    text: row.text,
    createdAt: row.created_at,
  };
}

export class DocSession extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  list(): Annotation[] {
    const comments = this.sql
      .exec<CommentRow>("SELECT * FROM comments ORDER BY created_at, rowid")
      .toArray();
    return this.sql
      .exec<AnnotationRow>("SELECT * FROM annotations ORDER BY created_at, rowid")
      .toArray()
      .map((row) =>
        this.toAnnotation(
          row,
          comments.filter((c) => c.annotation_id === row.id),
        ),
      );
  }

  create(actor: Actor, version: number, shape: AnnotationShape): Annotation {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO annotations (id, shape, version, author_id, author_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      JSON.stringify(shape),
      version,
      actor.userId,
      actor.name,
      now,
      now,
    );
    return this.changed(id);
  }

  edit(actor: Actor, id: string, patch: AnnotationPatch): Outcome<Annotation> {
    const row = this.row(id);
    if (!row) return refuse("not_found");
    if (!mayChangeAnnotation(actor, row.author_id, "edit")) return refuse("forbidden");
    const shape = AnnotationShape.parse(JSON.parse(row.shape));
    if (patch.text !== undefined && shape.kind !== "note") return refuse("invalid_input");
    const next: AnnotationShape = {
      ...shape,
      ...(patch.color !== undefined && { color: patch.color }),
      ...(patch.text !== undefined && shape.kind === "note" && { text: patch.text }),
    };
    this.sql.exec(
      "UPDATE annotations SET shape = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(next),
      Date.now(),
      id,
    );
    return { ok: true, value: this.changed(id) };
  }

  remove(actor: Actor, id: string): Outcome<null> {
    const row = this.row(id);
    if (!row) return refuse("not_found");
    if (!mayChangeAnnotation(actor, row.author_id, "delete")) return refuse("forbidden");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM comments WHERE annotation_id = ?", id);
      this.sql.exec("DELETE FROM annotations WHERE id = ?", id);
    });
    this.broadcast({ type: "deleted", id });
    return { ok: true, value: null };
  }

  addComment(actor: Actor, id: string, text: string): Outcome<Annotation> {
    if (!this.row(id)) return refuse("not_found");
    this.sql.exec(
      "INSERT INTO comments (id, annotation_id, author_id, author_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      id,
      actor.userId,
      actor.name,
      text,
      Date.now(),
    );
    return { ok: true, value: this.changed(id) };
  }

  setResolved(id: string, resolved: boolean): Outcome<Annotation> {
    if (!this.row(id)) return refuse("not_found");
    this.sql.exec(
      "UPDATE annotations SET resolved_at = ? WHERE id = ?",
      resolved ? Date.now() : null,
      id,
    );
    return { ok: true, value: this.changed(id) };
  }

  /** The live channel: a hibernating WebSocket that receives every change and presence. */
  override fetch(request: Request): Response {
    const actor = JSON.parse(request.headers.get(ACTOR_HEADER) ?? "null") as Actor | null;
    if (request.headers.get("upgrade") !== "websocket" || !actor) {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: actor.userId, name: actor.name } satisfies Author);
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed by the runtime
    }
    this.broadcastPresence(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.broadcastPresence(ws);
  }

  private row(id: string): AnnotationRow | undefined {
    return this.sql.exec<AnnotationRow>("SELECT * FROM annotations WHERE id = ?", id).toArray()[0];
  }

  private toAnnotation(row: AnnotationRow, comments: readonly CommentRow[]): Annotation {
    return {
      id: row.id,
      shape: AnnotationShape.parse(JSON.parse(row.shape)),
      version: row.version,
      author: { id: row.author_id, name: row.author_name },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      comments: comments.map(toComment),
    };
  }

  /** Reads `id` back after a write and sends it to every open viewer. */
  private changed(id: string): Annotation {
    const row = this.row(id);
    if (!row) throw new Error(`annotation ${id} vanished during its write`);
    const comments = this.sql
      .exec<CommentRow>(
        "SELECT * FROM comments WHERE annotation_id = ? ORDER BY created_at, rowid",
        id,
      )
      .toArray();
    const annotation = this.toAnnotation(row, comments);
    this.broadcast({ type: "annotation", annotation });
    return annotation;
  }

  private broadcast(message: LiveMessage, except?: WebSocket): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // a socket closing right now; its close handler updates presence
      }
    }
  }

  private broadcastPresence(closing?: WebSocket): void {
    const members = new Map<string, Author>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing) continue;
      const who = ws.deserializeAttachment() as Author | null;
      if (who) members.set(who.id, who);
    }
    this.broadcast({ type: "presence", members: [...members.values()] }, closing);
  }
}
