import { expireSeededSession, mayChangeAnnotation } from "@inkly/auth";
import type { Annotation, AnnotationShape, DocumentInfo, LiveMessage } from "@inkly/domain";
import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  accessLog,
  as,
  json,
  hooks,
  ORIGIN,
  outbox,
  seed,
  uniqueEmail,
  uploaded,
  type Seeded,
} from "./helpers.ts";

const highlight: AnnotationShape = {
  kind: "highlight",
  page: 1,
  color: "yellow",
  rects: [{ x: 0.1, y: 0.1, w: 0.4, h: 0.05 }],
};
const note: AnnotationShape = {
  kind: "note",
  page: 2,
  color: "blue",
  at: { x: 0.5, y: 0.5 },
  text: "Check the date",
};
const ink: AnnotationShape = {
  kind: "ink",
  page: 3,
  color: "red",
  strokes: [
    [
      { x: 0.2, y: 0.2 },
      { x: 0.6, y: 0.7 },
    ],
  ],
};

/** A User who joined `owner`'s Pro Tenant through an invitation, with `role`. */
async function member(owner: Seeded, role: "admin" | "editor" | "viewer", name: string) {
  const email = uniqueEmail(role);
  const invited = await as(owner, "/api/tenant/invitations", json("POST", { email, role }));
  expect(invited.status).toBe(201);
  const joiner = await seed({ email, name });
  const id = /\/invitations\/([A-Za-z0-9_-]+)/.exec((await outbox(email))[0]?.text ?? "")?.[1];
  const accepted = await as(joiner, `/api/invitations/${id ?? ""}/accept`, { method: "POST" });
  expect(accepted.status).toBe(200);
  return joiner;
}

async function team() {
  const owner = await seed({ plan: "pro", name: "Olive Owner" });
  const doc = await uploaded(owner, "10p.pdf");
  return {
    owner,
    doc,
    editor: await member(owner, "editor", "Eddie Editor"),
    other: await member(owner, "editor", "Otto Other"),
    admin: await member(owner, "admin", "Ada Admin"),
    viewer: await member(owner, "viewer", "Vic Viewer"),
  };
}

async function add(who: Seeded, doc: DocumentInfo, shape: AnnotationShape): Promise<Annotation> {
  const res = await as(who, `/api/documents/${doc.id}/annotations`, json("POST", shape));
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json<{ annotation: Annotation }>()).annotation;
}

async function list(who: Seeded, doc: DocumentInfo): Promise<Annotation[]> {
  const res = await as(who, `/api/documents/${doc.id}/annotations`);
  expect(res.status).toBe(200);
  return (await res.json<{ annotations: Annotation[] }>()).annotations;
}

/** Opens the live channel as `who` and collects every message it receives. */
async function live(who: Seeded, doc: DocumentInfo) {
  const res = await as(who, `/api/documents/${doc.id}/annotations/live`, {
    headers: { upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no WebSocket on the upgrade response");
  ws.accept();
  const messages: LiveMessage[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(String(e.data)) as LiveMessage);
  });
  const next = async (match: (m: LiveMessage) => boolean): Promise<LiveMessage> => {
    for (let i = 0; i < 100; i++) {
      const found = messages.find(match);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no matching live message; got ${JSON.stringify(messages)}`);
  };
  return { ws, messages, next };
}

describe("mayChangeAnnotation", () => {
  it.each([
    ["editor", "u_author", "edit", true],
    ["editor", "u_author", "delete", true],
    ["editor", "u_other", "edit", false],
    ["editor", "u_other", "delete", false],
    ["admin", "u_other", "edit", false],
    ["admin", "u_other", "delete", true],
    ["owner", "u_other", "delete", true],
    ["viewer", "u_author", "delete", false],
  ] as const)("%s acting as %s may %s: %s", (role, userId, change, allowed) => {
    expect(mayChangeAnnotation({ userId, role }, "u_author", change)).toBe(allowed);
  });
});

describe("annotations", () => {
  it("returns a highlight, a note and ink with author, Version and time", async () => {
    const { doc, editor } = await team();
    const before = Date.now();
    for (const shape of [highlight, note, ink]) await add(editor, doc, shape);
    const annotations = await list(editor, doc);
    expect(annotations.map((a) => a.shape)).toEqual([highlight, note, ink]);
    for (const a of annotations) {
      expect(a).toMatchObject({
        version: 1,
        author: { id: editor.userId, name: "Eddie Editor" },
        resolvedAt: null,
        comments: [],
      });
      expect(a.createdAt).toBeGreaterThanOrEqual(before);
    }
  });

  it("lives in the DocSession named {tenantId}/{documentId}", async () => {
    const { owner, doc } = await team();
    await add(owner, doc, highlight);
    const name = env.DOC_SESSIONS.idFromName(`${owner.tenantId}/${doc.id}`).toString();
    const ids = (await listDurableObjectIds(env.DOC_SESSIONS)).map((id) => id.toString());
    expect(ids).toContain(name);
  });

  it("refuses a page the Document does not have and a malformed shape", async () => {
    const { owner, doc } = await team();
    const path = `/api/documents/${doc.id}/annotations`;
    expect((await as(owner, path, json("POST", { ...highlight, page: 11 }))).status).toBe(422);
    expect((await as(owner, path, json("POST", { kind: "stamp", page: 1 }))).status).toBe(422);
  });

  it("lets authors edit and delete their own; owners and admins delete any", async () => {
    const { owner, doc, editor, other, admin } = await team();
    const mine = await add(editor, doc, note);
    const path = `/api/documents/${doc.id}/annotations/${mine.id}`;

    const edited = await as(editor, path, json("PATCH", { text: "New date", color: "green" }));
    expect(edited.status).toBe(200);
    expect((await edited.json<{ annotation: Annotation }>()).annotation.shape).toMatchObject({
      text: "New date",
      color: "green",
    });
    const highlighted = await add(editor, doc, highlight);
    const textOnHighlight = await as(
      editor,
      `/api/documents/${doc.id}/annotations/${highlighted.id}`,
      json("PATCH", { text: "nope" }),
    );
    expect(textOnHighlight.status).toBe(422);

    expect((await as(other, path, json("PATCH", { color: "red" }))).status).toBe(403);
    expect((await as(admin, path, json("PATCH", { color: "red" }))).status).toBe(403);
    expect((await as(other, path, { method: "DELETE" })).status).toBe(403);
    expect((await accessLog(owner.tenantId)).filter((e) => e.status === 403)).toHaveLength(3);

    expect((await as(admin, path, { method: "DELETE" })).status).toBe(200);
    const theirs = await add(other, doc, ink);
    const ownerDelete = await as(owner, `/api/documents/${doc.id}/annotations/${theirs.id}`, {
      method: "DELETE",
    });
    expect(ownerDelete.status).toBe(200);
    const ownDelete = await as(editor, `/api/documents/${doc.id}/annotations/${highlighted.id}`, {
      method: "DELETE",
    });
    expect(ownDelete.status).toBe(200);
    expect(await list(owner, doc)).toEqual([]);
    expect((await as(owner, path, { method: "DELETE" })).status).toBe(404);
  });

  it("keeps a Comment thread in order with author and time; resolves and reopens it", async () => {
    const { doc, editor, other } = await team();
    const a = await add(editor, doc, highlight);
    const thread = `/api/documents/${doc.id}/annotations/${a.id}`;
    for (const [who, text] of [
      [other, "Is this right?"],
      [editor, "Yes"],
      [other, "Thanks"],
    ] as const) {
      expect((await as(who, `${thread}/comments`, json("POST", { text }))).status).toBe(201);
    }
    const [read] = await list(editor, doc);
    expect(read?.comments.map((c) => [c.author.name, c.text])).toEqual([
      ["Otto Other", "Is this right?"],
      ["Eddie Editor", "Yes"],
      ["Otto Other", "Thanks"],
    ]);
    const times = read?.comments.map((c) => c.createdAt) ?? [];
    expect([...times].sort((x, y) => x - y)).toEqual(times);

    const resolved = await as(other, `${thread}/resolve`, { method: "POST" });
    expect((await resolved.json<{ annotation: Annotation }>()).annotation.resolvedAt).toEqual(
      expect.any(Number),
    );
    const reopened = await as(editor, `${thread}/reopen`, { method: "POST" });
    expect((await reopened.json<{ annotation: Annotation }>()).annotation.resolvedAt).toBeNull();
    expect(
      (await as(editor, `/api/documents/${doc.id}/annotations/nope/resolve`, { method: "POST" }))
        .status,
    ).toBe(404);
  });

  it("lets a viewer read and refuses every write with a logged 403", async () => {
    const { owner, doc, editor, viewer } = await team();
    const a = await add(editor, doc, highlight);
    expect(await list(viewer, doc)).toHaveLength(1);
    const base = `/api/documents/${doc.id}/annotations`;
    const attempts = [
      await as(viewer, base, json("POST", highlight)),
      await as(viewer, `${base}/${a.id}`, json("PATCH", { color: "red" })),
      await as(viewer, `${base}/${a.id}`, { method: "DELETE" }),
      await as(viewer, `${base}/${a.id}/comments`, json("POST", { text: "hi" })),
      await as(viewer, `${base}/${a.id}/resolve`, { method: "POST" }),
    ];
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    const denied = (await accessLog(owner.tenantId)).filter((e) => e.status === 403);
    expect(denied.map((e) => e.action)).toEqual(["write", "write", "write", "write", "write"]);
    expect(await list(owner, doc)).toEqual([expect.objectContaining({ id: a.id, comments: [] })]);
  });

  it("answers 404 (logged) to another Tenant on read, write and WebSocket upgrade", async () => {
    const { doc, editor } = await team();
    const a = await add(editor, doc, highlight);
    const outsider = await seed();
    const base = `/api/documents/${doc.id}`;
    const attempts = [
      await as(outsider, `${base}/annotations`),
      await as(outsider, `${base}/annotations`, json("POST", highlight)),
      await as(outsider, `${base}/annotations/${a.id}`, json("PATCH", { color: "red" })),
      await as(outsider, `${base}/annotations/${a.id}`, { method: "DELETE" }),
      await as(outsider, `${base}/annotations/${a.id}/comments`, json("POST", { text: "x" })),
      await as(outsider, `${base}/annotations/live`, { headers: { upgrade: "websocket" } }),
      await as(outsider, `${base}/annotated-content`),
    ];
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404, 404]);
    expect(attempts.every((r) => r.webSocket === null)).toBe(true);
    expect((await accessLog(outsider.tenantId)).map((e) => e.status)).toEqual(
      Array<number>(7).fill(404),
    );
    expect(await list(editor, doc)).toEqual([expect.objectContaining({ id: a.id, comments: [] })]);
  });
});

describe("the live channel", () => {
  it("pushes adds, edits, comments and deletes to every open viewer, with presence", async () => {
    const { doc, editor, viewer } = await team();
    const watcher = await live(viewer, doc);
    const author = await live(editor, doc);
    const both = (m: LiveMessage) => m.type === "presence" && m.members.length === 2;
    const presence = await watcher.next(both);
    expect(presence.type === "presence" && presence.members.map((m) => m.name).sort()).toEqual([
      "Eddie Editor",
      "Vic Viewer",
    ]);
    await author.next(both);

    const a = await add(editor, doc, highlight);
    await watcher.next((m) => m.type === "annotation" && m.annotation.id === a.id);
    const path = `/api/documents/${doc.id}/annotations/${a.id}`;
    await as(editor, path, json("PATCH", { color: "green" }));
    await watcher.next((m) => m.type === "annotation" && m.annotation.shape.color === "green");
    await as(editor, `${path}/comments`, json("POST", { text: "Live" }));
    await watcher.next((m) => m.type === "annotation" && m.annotation.comments[0]?.text === "Live");
    await as(editor, path, { method: "DELETE" });
    await watcher.next((m) => m.type === "deleted" && m.id === a.id);

    author.ws.close(1000, "bye");
    await watcher.next(
      (m) => m.type === "presence" && m.members.length === 1 && m.members[0]?.name === "Vic Viewer",
    );
    watcher.ws.close(1000, "bye");
  });

  it.each(["membership removed", "signed out", "expired", "trashed", "legacy attachment"] as const)(
    "stops an existing live channel after access is %s",
    async (reason) => {
      const { owner, doc, viewer } = await team();
      const annotation = await add(owner, doc, highlight);
      const watcher = await live(viewer, doc);
      await watcher.next((m) => m.type === "presence");
      watcher.messages.length = 0;
      const closed = new Promise<number>((resolve) => {
        watcher.ws.addEventListener("close", (event) => {
          resolve(event.code);
        });
      });
      if (reason === "membership removed") {
        expect(
          (await as(owner, `/api/tenant/members/${viewer.userId}`, { method: "DELETE" })).status,
        ).toBe(204);
      } else if (reason === "signed out") {
        expect((await as(viewer, "/api/auth/sign-out", { method: "POST" })).status).toBe(200);
      } else if (reason === "trashed") {
        expect((await as(owner, `/api/documents/${doc.id}`, { method: "DELETE" })).status).toBe(
          200,
        );
      }
      if (reason === "legacy attachment") {
        const session = env.DOC_SESSIONS.get(
          env.DOC_SESSIONS.idFromName(`${owner.tenantId}/${doc.id}`),
        );
        await runInDurableObject(session, (_instance, state) => {
          for (const ws of state.getWebSockets())
            ws.serializeAttachment({ id: viewer.userId, name: "Vic Viewer" });
        });
      }
      if (reason === "expired") {
        await expireSeededSession(new Request(ORIGIN), hooks, viewer.token);
      }
      try {
        const session = env.DOC_SESSIONS.get(
          env.DOC_SESSIONS.idFromName(`${owner.tenantId}/${doc.id}`),
        );
        await session.setResolved(annotation.id, true);
        expect(await closed).toBe(1008);
        expect(watcher.messages.filter((m) => m.type === "annotation")).toEqual([]);
        expect(watcher.ws.readyState).toBe(WebSocket.CLOSED);
      } finally {
        watcher.ws.close();
      }
    },
  );

  it("refuses annotation reads, writes, downloads and upgrades for a trashed Document", async () => {
    const { owner, doc } = await team();
    await as(owner, `/api/documents/${doc.id}`, { method: "DELETE" });
    const base = `/api/documents/${doc.id}`;
    const responses = [
      await as(owner, `${base}/annotations`),
      await as(owner, `${base}/annotations`, json("POST", highlight)),
      await as(owner, `${base}/annotated-content`),
      await as(owner, `${base}/annotations/live`, { headers: { upgrade: "websocket" } }),
    ];
    expect(responses.map((res) => res.status)).toEqual([404, 404, 404, 404]);
    for (const res of responses) res.webSocket?.close();
  });

  it("retains no credential and refuses an identity scoped to a different DocSession", async () => {
    const { owner, doc } = await team();
    const watcher = await live(owner, doc);
    const session = env.DOC_SESSIONS.get(
      env.DOC_SESSIONS.idFromName(`${owner.tenantId}/${doc.id}`),
    );
    const identity = await runInDurableObject(
      session,
      (_instance, state) =>
        state.getWebSockets()[0]?.deserializeAttachment() as Record<string, unknown>,
    );
    expect(Object.keys(identity).sort()).toEqual([
      "author",
      "documentId",
      "sessionId",
      "tenantId",
      "userId",
    ]);
    expect(identity).toMatchObject({
      userId: owner.userId,
      tenantId: owner.tenantId,
      documentId: doc.id,
    });
    expect(JSON.stringify(identity)).not.toContain(owner.token);
    const other = await uploaded(owner, "tiny.pdf");
    const wrongSession = env.DOC_SESSIONS.get(
      env.DOC_SESSIONS.idFromName(`${owner.tenantId}/${other.id}`),
    );
    const response = await wrongSession.fetch("https://doc-session/live", {
      headers: { upgrade: "websocket", "x-inkly-actor": JSON.stringify(identity) },
    });
    expect(response.status).toBe(404);
    expect(response.webSocket).toBeNull();
    watcher.ws.close();
  });

  it("refuses a plain GET on the live URL with 426", async () => {
    const { owner, doc } = await team();
    expect((await as(owner, `/api/documents/${doc.id}/annotations/live`)).status).toBe(426);
  });
});

describe("download with annotations", () => {
  it("serves the current Version with its annotations as PDF annotations and stores nothing", async () => {
    const { owner, doc, editor } = await team();
    for (const shape of [highlight, note, ink]) await add(editor, doc, shape);
    const res = await as(owner, `/api/documents/${doc.id}/annotated-content`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("10p (annotated).pdf");
    const pdf = await PDFDocument.load(await res.arrayBuffer());
    expect(pdf.getPageCount()).toBe(10);
    const annotsOn = (i: number) => pdf.getPage(i).node.Annots()?.size() ?? 0;
    expect([annotsOn(0), annotsOn(1), annotsOn(2), annotsOn(3)]).toEqual([1, 1, 1, 0]);

    const versions = await (
      await as(owner, `/api/documents/${doc.id}/versions`)
    ).json<{
      versions: unknown[];
    }>();
    expect(versions.versions).toHaveLength(1);
    const granted = (await accessLog(owner.tenantId)).filter(
      (e) => e.status === 200 && e.action === "read-content",
    );
    expect(granted.map((e) => e.resource)).toEqual([`document ${doc.id} v1 with annotations`]);
  });

  it("leaves out annotations drawn on an earlier Version", async () => {
    const { owner, doc } = await team();
    await add(owner, doc, highlight);
    const tiny = await uploaded(owner, "tiny.pdf");
    const upload = await as(owner, `/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: await (await as(owner, `/api/documents/${tiny.id}/content`)).arrayBuffer(),
    });
    expect(upload.status).toBe(201);
    const res = await as(owner, `/api/documents/${doc.id}/annotated-content`);
    const pdf = await PDFDocument.load(await res.arrayBuffer());
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });
});
