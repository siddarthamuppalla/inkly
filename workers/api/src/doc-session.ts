import { liveSessionActive, mayChangeAnnotation, type Role, type Session } from "@inkly/auth";
import {
  AnnotationShape,
  type Annotation,
  type AnnotationPatch,
  type Author,
  type Comment,
  type DocumentId,
  type LiveMessage,
  type TenantId,
} from "@inkly/domain";
import { getDocument, type DocumentRow } from "@inkly/storage";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env.ts";

// DocSession (GLOSSARY): one per Document, named `{tenantId}/{documentId}`, the single
// writer of its Annotations and Comments. Only the API Worker holds the binding, and it
// calls in only after requireTenant and a Document lookup. Live recipients are reauthorized
// before each outbound frame because an open socket can outlive that initial access.

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

/** Header carrying scoped live identity on the private upgrade forwarded by the API. */
export const ACTOR_HEADER = "x-inkly-actor";

interface LiveIdentity extends Pick<Session, "sessionId" | "userId" | "tenantId"> {
  readonly author: Author;
  readonly documentId: DocumentId;
}

function isLiveIdentity(value: Partial<LiveIdentity> | null): value is LiveIdentity {
  return (
    value !== null &&
    typeof value.sessionId === "string" &&
    typeof value.userId === "string" &&
    typeof value.tenantId === "string" &&
    typeof value.documentId === "string" &&
    value.author?.id === value.userId &&
    typeof value.author.name === "string"
  );
}

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

  async create(actor: Actor, version: number, shape: AnnotationShape): Promise<Annotation> {
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

  async edit(actor: Actor, id: string, patch: AnnotationPatch): Promise<Outcome<Annotation>> {
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
    return { ok: true, value: await this.changed(id) };
  }

  async remove(actor: Actor, id: string): Promise<Outcome<null>> {
    const row = this.row(id);
    if (!row) return refuse("not_found");
    if (!mayChangeAnnotation(actor, row.author_id, "delete")) return refuse("forbidden");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM comments WHERE annotation_id = ?", id);
      this.sql.exec("DELETE FROM annotations WHERE id = ?", id);
    });
    await this.broadcast({ type: "deleted", id });
    return { ok: true, value: null };
  }

  async addComment(actor: Actor, id: string, text: string): Promise<Outcome<Annotation>> {
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
    return { ok: true, value: await this.changed(id) };
  }

  async setResolved(id: string, resolved: boolean): Promise<Outcome<Annotation>> {
    if (!this.row(id)) return refuse("not_found");
    this.sql.exec(
      "UPDATE annotations SET resolved_at = ? WHERE id = ?",
      resolved ? Date.now() : null,
      id,
    );
    return { ok: true, value: await this.changed(id) };
  }

  /** The live channel: a hibernating WebSocket that receives every change and presence. */
  override async fetch(request: Request): Promise<Response> {
    const identity = JSON.parse(
      request.headers.get(ACTOR_HEADER) ?? "null",
    ) as Partial<LiveIdentity> | null;
    if (request.headers.get("upgrade") !== "websocket" || !isLiveIdentity(identity)) {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const expected = this.env.DOC_SESSIONS.idFromName(
      `${identity.tenantId}/${identity.documentId}`,
    );
    if (!expected.equals(this.ctx.id) || !(await this.allowed(identity))) {
      return new Response("not found", { status: 404 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(identity);
    await this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Clients only send "ping", which the auto-response answers; anything else is ignored. */
  override webSocketMessage(): void {
    return;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed by the runtime
    }
    await this.broadcastPresence(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.broadcastPresence(ws);
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
  private async changed(id: string): Promise<Annotation> {
    const row = this.row(id);
    if (!row) throw new Error(`annotation ${id} vanished during its write`);
    const comments = this.sql
      .exec<CommentRow>(
        "SELECT * FROM comments WHERE annotation_id = ? ORDER BY created_at, rowid",
        id,
      )
      .toArray();
    const annotation = this.toAnnotation(row, comments);
    await this.broadcast({ type: "annotation", annotation });
    return annotation;
  }

  private async allowed(identity: LiveIdentity): Promise<boolean> {
    const [active, doc] = await Promise.all([
      liveSessionActive(identity, this.env),
      getDocument(identity.tenantId, this.env, identity.documentId),
    ]);
    return active && doc !== null && doc.deletedAt === null;
  }

  private async recipients(except?: WebSocket): Promise<WebSocket[]> {
    const sockets = await Promise.all(
      this.ctx.getWebSockets().map(async (ws) => {
        if (ws === except || ws.readyState !== WebSocket.OPEN) return null;
        const identity = ws.deserializeAttachment() as Partial<LiveIdentity> | null;
        if (isLiveIdentity(identity) && (await this.allowed(identity))) return ws;
        ws.close(1008, "Access ended");
        return null;
      }),
    );
    return sockets.filter((ws): ws is WebSocket => ws !== null);
  }

  private send(sockets: readonly WebSocket[], message: LiveMessage): void {
    const text = JSON.stringify(message);
    for (const ws of sockets) {
      try {
        ws.send(text);
      } catch {
        // a socket closing right now; its close handler updates presence
      }
    }
  }

  private async broadcast(message: LiveMessage): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.send(await this.recipients(), message);
    });
  }

  private async broadcastPresence(closing?: WebSocket): Promise<void> {
    const sockets = await this.recipients(closing);
    const members = new Map<string, Author>();
    for (const ws of sockets) {
      const identity = ws.deserializeAttachment() as LiveIdentity;
      members.set(identity.author.id, identity.author);
    }
    this.send(sockets, { type: "presence", members: [...members.values()] });
  }
}
