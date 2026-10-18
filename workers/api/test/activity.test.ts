import type { Role } from "@inkly/auth";
import type { ActivityEntry, ShareLinkInfo, TenantId, UserId } from "@inkly/domain";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { activityRoutes } from "../src/activity.ts";
import { onAppError } from "../src/errors.ts";
import app, { type Env } from "../src/index.ts";
import { shareLinkRoutes } from "../src/share-links.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { rows } from "./d1.ts";
import { accessLog, as, hooks, json, ORIGIN, seed, uploaded } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const VISITOR = { "cf-connecting-ip": "198.51.100.4", "user-agent": "Visitor/2.0" };

interface Page {
  entries: ActivityEntry[];
  next: number | null;
}

function visit(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(VISITOR)) headers.set(k, v);
  return Promise.resolve(app.request(`${ORIGIN}${path}`, { ...init, headers }, hooks));
}

async function activity(who: { token: string }, documentId: string, query = ""): Promise<Page> {
  const res = await as(who, `/api/documents/${documentId}/activity${query}`);
  if (res.status !== 200) throw new Error(`activity returned ${String(res.status)}`);
  return res.json<Page>();
}

async function share(who: { token: string }, documentId: string, extra = {}) {
  const res = await as(
    who,
    "/api/share-links",
    json("POST", { documentId, expiresAt: Date.now() + DAY, ...extra }),
  );
  const body = await res.json<{ link: ShareLinkInfo; url: string }>();
  return { link: body.link, token: body.url.slice(3) };
}

function appAs(who: { tenantId: TenantId; userId: string }, role: Role) {
  const session = {
    sessionId: "fixture-session",
    tenantId: who.tenantId,
    userId: who.userId as UserId,
    role,
  };
  const scoped = new Hono<{ Bindings: Env; Variables: TenantVars }>();
  scoped.onError(onAppError);
  scoped.use("*", async (c, next) => {
    c.set("session", session);
    c.set("tenantId", who.tenantId);
    await next();
  });
  scoped.route("/api/documents", activityRoutes);
  scoped.route("/api/share-links", shareLinkRoutes);
  return (path: string) => scoped.request(path, {}, hooks);
}

describe("a Document's activity", () => {
  it("lists Member and Share-link entries newest first with actor, action, IP and time", async () => {
    const a = await seed({ name: "Ada Owner", plan: "pro" });
    const doc = await uploaded(a, "tiny.pdf");
    await (await as(a, `/api/documents/${doc.id}/content`)).arrayBuffer();
    await as(a, `/api/documents/${doc.id}`, json("PATCH", { title: "Renamed" }));
    const { link, token } = await share(a, doc.id, { password: "correct horse" });
    await visit(`/api/share/${token}/unlock`, json("POST", { password: "nope nope" }));
    const unlocked = await visit(
      `/api/share/${token}/unlock`,
      json("POST", { password: "correct horse" }),
    );
    const cookie = (unlocked.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    await visit(`/api/share/${token}`, { headers: { cookie } });
    await (await visit(`/api/share/${token}/content`, { headers: { cookie } })).arrayBuffer();
    await (
      await visit(`/api/share/${token}/content?download=1`, { headers: { cookie } })
    ).arrayBuffer();

    const { entries, next } = await activity(a, doc.id);
    expect(next).toBeNull();
    const member = { kind: "member", userId: a.userId, name: "Ada Owner" };
    const viaLink = { kind: "share-link", shareLinkId: link.id };
    expect(entries.map((e) => [e.action, e.actor])).toEqual([
      ["downloaded", viaLink],
      ["viewed", viaLink],
      ["unlocked", viaLink],
      ["denied", viaLink],
      ["edited", member],
      ["viewed", member],
    ]);
    expect(entries[0]).toMatchObject({ ip: "198.51.100.4", userAgent: "Visitor/2.0" });
    expect(entries[5]).toMatchObject({ ip: null, userAgent: null });
    const ids = entries.map((e) => e.id);
    expect([...ids].sort((x, y) => y - x)).toEqual(ids);
    for (const e of entries) expect(e.at).toBeGreaterThan(0);
  });

  it("pages with ?limit and ?before without gaps or repeats", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    for (let i = 0; i < 5; i++)
      await (await as(a, `/api/documents/${doc.id}/content`)).arrayBuffer();
    const first = await activity(a, doc.id, "?limit=2");
    expect(first.entries).toHaveLength(2);
    const second = await activity(a, doc.id, `?limit=2&before=${String(first.next)}`);
    const third = await activity(a, doc.id, `?limit=2&before=${String(second.next)}`);
    expect(third).toMatchObject({ next: null });
    const all = await activity(a, doc.id);
    expect([...first.entries, ...second.entries, ...third.entries].map((e) => e.id)).toEqual(
      all.entries.map((e) => e.id),
    );
    expect(all.entries).toHaveLength(5);
  });

  it("records every successful edit of a Document, but not its upload", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    expect((await activity(a, doc.id)).entries).toEqual([]);
    await as(a, `/api/documents/${doc.id}`, json("PATCH", { title: "B" }));
    await as(a, `/api/documents/${doc.id}`, { method: "DELETE" });
    await as(a, `/api/documents/${doc.id}/restore`, { method: "POST" });
    const rotated = await as(
      a,
      `/api/documents/${doc.id}/rotate`,
      json("POST", { pages: [1], degrees: 90 }),
    );
    expect(rotated.status).toBe(201);
    const other = await uploaded(a, "tiny.pdf");
    const merged = await as(
      a,
      "/api/documents/merge",
      json("POST", { documentIds: [doc.id, other.id] }),
    );
    expect(merged.status).toBe(201);
    expect((await activity(a, doc.id)).entries.map((e) => e.action)).toEqual([
      "edited",
      "edited",
      "edited",
      "edited",
    ]);
    expect((await accessLog(a.tenantId)).filter((e) => e.resource.includes("/merge"))).toEqual([]);
  });

  it("is refused to viewers (403, logged) and to other Tenants (404)", async () => {
    const a = await seed();
    const b = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const { link } = await share(a, doc.id);
    const viewer = appAs(a, "viewer");
    expect((await viewer(`/api/documents/${doc.id}/activity`)).status).toBe(403);
    expect((await viewer(`/api/share-links/${link.id}/activity`)).status).toBe(403);
    expect((await accessLog(a.tenantId)).filter((e) => e.status === 403)).toHaveLength(2);
    for (const role of ["owner", "admin", "editor"] as const) {
      expect((await appAs(a, role)(`/api/documents/${doc.id}/activity`)).status).toBe(200);
    }
    expect((await as(b, `/api/documents/${doc.id}/activity`)).status).toBe(404);
    expect((await as(b, `/api/share-links/${link.id}/activity`)).status).toBe(404);
    const foreignViewer = appAs(b, "viewer");
    expect((await foreignViewer(`/api/documents/${doc.id}/activity`)).status).toBe(404);
    expect((await foreignViewer(`/api/share-links/${link.id}/activity`)).status).toBe(404);
  });
});

describe("a Share link's opens", () => {
  it("lists only that link's entries", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const one = await share(a, doc.id);
    const two = await share(a, doc.id);
    await visit(`/api/share/${one.token}`);
    await visit(`/api/share/${one.token}`);
    await visit(`/api/share/${two.token}`);
    const res = await as(a, `/api/share-links/${one.link.id}/activity`);
    const page = await res.json<Page>();
    expect(page.entries.map((e) => [e.action, e.actor])).toEqual([
      ["viewed", { kind: "share-link", shareLinkId: one.link.id }],
      ["viewed", { kind: "share-link", shareLinkId: one.link.id }],
    ]);
  });
});

describe("migration 0009", () => {
  it("backfills document_id from the resource of earlier entries", async () => {
    const a = await seed();
    const legacy = [
      ["read-content", "document doc_legacy1 v3", 200],
      ["read", "document doc_legacy2", 200],
      ["write", "PATCH /api/documents/doc_legacy3", 403],
      ["read-content", "GET /api/documents/doc_legacy4/versions/2/content", 404],
      ["list", "GET /api/documents", 404],
      ["write", "POST /api/documents/merge", 404],
      ["write", "active-tenant ten_x", 403],
    ] as const;
    for (const [action, resource, status] of legacy) {
      await rows(
        "INSERT INTO access_log (tenant_id, actor_user_id, action, resource, status, at) VALUES (?1, 'usr_x', ?2, ?3, ?4, 1)",
        a.tenantId,
        action,
        resource,
        status,
      );
    }
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0009_"));
    for (const query of migration?.queries ?? []) {
      if (/^\s*UPDATE access_log/m.test(query)) await rows(query);
    }
    const backfilled = await rows<{ resource: string; document_id: string | null }>(
      "SELECT resource, document_id FROM access_log WHERE tenant_id = ?1 ORDER BY id",
      a.tenantId,
    );
    expect(backfilled.map((r) => r.document_id)).toEqual([
      "doc_legacy1",
      "doc_legacy2",
      "doc_legacy3",
      "doc_legacy4",
      null,
      null,
      null,
    ]);
  });
});
