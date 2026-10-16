import type { Role } from "@inkly/auth";
import type { ShareLinkInfo, TenantId, UserId } from "@inkly/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { onAppError } from "../src/errors.ts";
import app, { type Env } from "../src/index.ts";
import { shareLinkRoutes } from "../src/share-links.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { rows } from "./d1.ts";
import { accessLog, as, fixture, hooks, json, ORIGIN, seed, sha256, uploaded } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const VISITOR = { "cf-connecting-ip": "203.0.113.7", "user-agent": "VisitorBrowser/1.0" };

interface Created {
  link: ShareLinkInfo;
  url: string;
}

async function share(
  who: { token: string },
  body: Record<string, unknown>,
): Promise<{ status: number; body: Created & { error?: string } }> {
  const res = await as(who, "/api/share-links", json("POST", body));
  return { status: res.status, body: await res.json<Created & { error?: string }>() };
}

async function shared(who: { token: string }, documentId: string, extra = {}) {
  const res = await share(who, { documentId, expiresAt: Date.now() + DAY, ...extra });
  if (res.status !== 201) throw new Error(`share returned ${String(res.status)}`);
  return { ...res.body, token: res.body.url.slice("/s/".length) };
}

/** A signed-out visitor's request. */
function visit(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(VISITOR)) headers.set(k, v);
  return Promise.resolve(app.request(`${ORIGIN}${path}`, { ...init, headers }, hooks));
}

function unlock(token: string, password: string) {
  return visit(`/api/share/${token}/unlock`, json("POST", { password }));
}

function grantCookie(res: Response): string {
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0] ?? "";
}

function appAs(who: { tenantId: TenantId; userId: string }, role: Role) {
  const session = { tenantId: who.tenantId, userId: who.userId as UserId, role };
  const viewer = new Hono<{ Bindings: Env; Variables: TenantVars }>();
  viewer.onError(onAppError);
  viewer.use("*", async (c, next) => {
    c.set("session", session);
    c.set("tenantId", who.tenantId);
    await next();
  });
  viewer.route("/api/share-links", shareLinkRoutes);
  return (path: string, init: RequestInit = {}) => viewer.request(path, init, hooks);
}

describe("creating a share link", () => {
  it("returns /s/{token} with 256 random bits, stores only its sha256 and lists it", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const res = await share(a, { documentId: doc.id, expiresAt: Date.now() + DAY });
    expect(res.status).toBe(201);
    const token = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(res.body.url)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(res.body.link).toMatchObject({
      documentId: doc.id,
      documentTitle: "tiny",
      hasPassword: false,
      allowDownload: true,
      revokedAt: null,
      opens: 0,
    });

    const stored = await rows<Record<string, unknown>>(
      "SELECT * FROM share_links WHERE tenant_id = ?1",
      a.tenantId,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.["token_hash"]).toBe(await sha256(new TextEncoder().encode(token)));
    expect(JSON.stringify(stored)).not.toContain(token);

    const forDoc = await (
      await as(a, `/api/share-links?documentId=${doc.id}`)
    ).json<{
      links: ShareLinkInfo[];
    }>();
    const all = await (await as(a, "/api/share-links")).json<{ links: ShareLinkInfo[] }>();
    expect(forDoc.links.map((l) => l.id)).toEqual([res.body.link.id]);
    expect(all.links.map((l) => l.id)).toEqual([res.body.link.id]);
  });

  it("gives every link a different token", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const one = await shared(a, doc.id);
    const two = await shared(a, doc.id);
    expect(one.token).not.toBe(two.token);
  });

  it("holds Free to 7 days, no password and download on (402 limit_exceeded)", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const week = Date.now() + 7 * DAY - 60_000;
    expect((await share(a, { documentId: doc.id, expiresAt: week })).status).toBe(201);
    for (const body of [
      { expiresAt: null },
      { expiresAt: Date.now() + 8 * DAY },
      { expiresAt: week, password: "correct horse" },
      { expiresAt: week, allowDownload: false },
    ]) {
      const res = await share(a, { documentId: doc.id, ...body });
      expect([res.status, res.body.error]).toEqual([402, "limit_exceeded"]);
    }
  });

  it("lets Pro set no expiry, a hashed password and download off", async () => {
    const a = await seed({ plan: "pro" });
    const doc = await uploaded(a, "tiny.pdf");
    const res = await share(a, {
      documentId: doc.id,
      expiresAt: null,
      password: "correct horse",
      allowDownload: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.link).toMatchObject({
      expiresAt: null,
      hasPassword: true,
      allowDownload: false,
    });
    const [stored] = await rows<{ password_hash: string }>(
      "SELECT password_hash FROM share_links WHERE tenant_id = ?1",
      a.tenantId,
    );
    expect(stored?.password_hash).toMatch(/^pbkdf2-sha256\$100000\$[\w-]+\$[\w-]+$/);
    expect(stored?.password_hash).not.toContain("correct horse");
  });

  it("refuses a viewer's create and revoke with a logged 403", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const link = await shared(owner, doc.id);
    const viewer = appAs(owner, "viewer");
    const create = await viewer(
      "/api/share-links",
      json("POST", { documentId: doc.id, expiresAt: Date.now() + DAY }),
    );
    const revoke = await viewer(`/api/share-links/${link.link.id}/revoke`, { method: "POST" });
    expect([create.status, revoke.status]).toEqual([403, 403]);
    expect((await accessLog(owner.tenantId)).filter((e) => e.status === 403)).toHaveLength(2);
    expect((await viewer("/api/share-links")).status).toBe(200);
  });
});

describe("opening a share link signed out", () => {
  it("serves the Document's current Version, inline unless download is asked for", async () => {
    const a = await seed();
    const doc = await uploaded(a, "10p.pdf");
    const { token } = await shared(a, doc.id);

    const info = await visit(`/api/share/${token}`);
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({
      title: "10p",
      pages: 10,
      allowDownload: true,
      locked: false,
    });

    const inline = await visit(`/api/share/${token}/content`);
    expect(inline.headers.get("content-disposition")).toMatch(/^inline/);
    expect(inline.headers.get("cache-control")).toBe("private, no-store");
    expect(inline.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await sha256(await inline.arrayBuffer())).toBe(await sha256(fixture("10p.pdf")));
    const download = await visit(`/api/share/${token}/content?download=1`);
    expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="10p.pdf"/);
    await download.arrayBuffer();

    await as(a, `/api/documents/${doc.id}/versions`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: fixture("tiny.pdf"),
    });
    const after = await visit(`/api/share/${token}/content`);
    expect(await sha256(await after.arrayBuffer())).toBe(await sha256(fixture("tiny.pdf")));
  });

  it("keeps download off inline even when download is asked for", async () => {
    const a = await seed({ plan: "pro" });
    const doc = await uploaded(a, "tiny.pdf");
    const { token } = await shared(a, doc.id, { allowDownload: false });
    expect(await (await visit(`/api/share/${token}`)).json()).toMatchObject({
      allowDownload: false,
    });
    const res = await visit(`/api/share/${token}/content?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^inline/);
  });

  it("logs every open and download in the owner's log with link, IP and user agent", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const { token, link } = await shared(a, doc.id);
    await visit(`/api/share/${token}`);
    await (await visit(`/api/share/${token}/content`)).arrayBuffer();
    await (await visit(`/api/share/${token}/content?download=1`)).arrayBuffer();

    const visits = (await accessLog(a.tenantId)).filter((e) => e.shareLinkId === link.id);
    expect(visits.map((e) => [e.action, e.status])).toEqual([
      ["read", 200],
      ["read-content", 200],
      ["download", 200],
    ]);
    for (const e of visits) {
      expect(e).toMatchObject({ ip: "203.0.113.7", userAgent: "VisitorBrowser/1.0" });
    }
    const listed = await (await as(a, "/api/share-links")).json<{ links: ShareLinkInfo[] }>();
    expect(listed.links[0]).toMatchObject({ opens: 1, lastOpenedAt: expect.any(Number) as number });
  });
});

describe("a password link", () => {
  async function locked() {
    const a = await seed({ plan: "pro" });
    const doc = await uploaded(a, "tiny.pdf");
    const created = await shared(a, doc.id, { password: "correct horse" });
    return { a, ...created };
  }

  it("returns 401 for content until the right password is entered", async () => {
    const { token } = await locked();
    expect(await (await visit(`/api/share/${token}`)).json()).toEqual({ locked: true });
    expect((await visit(`/api/share/${token}/content`)).status).toBe(401);

    const wrong = await unlock(token, "wrong horse");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await unlock(token, "correct horse");
    expect(right.status).toBe(204);
    const setCookie = right.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(new RegExp(`Path=/api/share/${token}`));
    expect(setCookie).toMatch(/SameSite=Strict/i);
    const cookie = grantCookie(right);

    const info = await visit(`/api/share/${token}`, { headers: { cookie } });
    expect(await info.json()).toMatchObject({ locked: false });
    const content = await visit(`/api/share/${token}/content`, { headers: { cookie } });
    expect(content.status).toBe(200);
    expect(await sha256(await content.arrayBuffer())).toBe(await sha256(fixture("tiny.pdf")));
  });

  it("does not accept a tampered grant", async () => {
    const { token } = await locked();
    const cookie = grantCookie(await unlock(token, "correct horse"));
    const [name, value = ""] = cookie.split("=");
    const [exp = "", sig = ""] = value.split(".");
    const forged = [
      `${String(name)}=${String(Number(exp) + 1)}.${sig}`,
      `${String(name)}=${exp}.${sig.slice(0, -2)}AA`,
      `${String(name)}=${exp}`,
    ];
    for (const c of forged) {
      expect((await visit(`/api/share/${token}/content`, { headers: { cookie: c } })).status).toBe(
        401,
      );
    }
  });

  it("does not accept one link's grant on another link", async () => {
    const one = await locked();
    const two = await locked();
    const cookie = grantCookie(await unlock(one.token, "correct horse"));
    expect((await visit(`/api/share/${two.token}/content`, { headers: { cookie } })).status).toBe(
      401,
    );
  });

  it("refuses the 11th unlock attempt in 10 minutes with 429, even with the right password", async () => {
    const { token } = await locked();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await unlock(token, `guess ${String(i)}`)).status);
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 401));
    expect((await unlock(token, "correct horse")).status).toBe(429);
  });

  it("logs each unlock attempt with its outcome", async () => {
    const { a, token, link } = await locked();
    await unlock(token, "nope nope");
    await unlock(token, "correct horse");
    const unlocks = (await accessLog(a.tenantId)).filter(
      (e) => e.shareLinkId === link.id && e.action === "unlock",
    );
    expect(unlocks.map((e) => e.status)).toEqual([401, 200]);
  });
});

describe("a link that no longer opens", () => {
  async function gone(kind: "expired" | "revoked" | "trashed") {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const created = await shared(a, doc.id);
    if (kind === "revoked") {
      expect(
        (await as(a, `/api/share-links/${created.link.id}/revoke`, { method: "POST" })).status,
      ).toBe(200);
    }
    if (kind === "trashed") await as(a, `/api/documents/${doc.id}`, { method: "DELETE" });
    if (kind === "expired") {
      await rowsUpdate(a.tenantId, created.link.id);
    }
    return { a, ...created };
  }

  async function rowsUpdate(tenantId: string, id: string) {
    await rows(
      "UPDATE share_links SET expires_at = ?3 WHERE tenant_id = ?1 AND id = ?2",
      tenantId,
      id,
      Date.now() - 1,
    );
  }

  it("answers 404 with the same body for expired, revoked, trashed and unknown tokens", async () => {
    const bodies = new Set<string>();
    for (const kind of ["expired", "revoked", "trashed"] as const) {
      const { token } = await gone(kind);
      for (const path of ["", "/content", "/content?download=1"]) {
        const res = await visit(`/api/share/${token}${path}`);
        expect([kind, path, res.status]).toEqual([kind, path, 404]);
        bodies.add(await res.text());
      }
      const res = await unlock(token, "whatever");
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    for (const token of ["A".repeat(43), "not-a-token", "x/y/content"]) {
      const res = await visit(`/api/share/${token}`);
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ error: "not_found", message: "This link is no longer available" }),
    ]);
  });

  it("takes effect on the very next request after Revoke, and logs the refused open", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const { token, link } = await shared(a, doc.id);
    expect((await visit(`/api/share/${token}`)).status).toBe(200);
    const revoked = await as(a, `/api/share-links/${link.id}/revoke`, { method: "POST" });
    expect((await revoked.json<{ link: ShareLinkInfo }>()).link.revokedAt).toEqual(
      expect.any(Number),
    );
    expect((await visit(`/api/share/${token}`)).status).toBe(404);
    const entries = (await accessLog(a.tenantId)).filter((e) => e.shareLinkId === link.id);
    expect(entries.map((e) => [e.action, e.status])).toEqual([
      ["read", 200],
      ["read", 404],
    ]);
  });
});

describe("share links across Tenants", () => {
  it("refuses listing, creating on and revoking another Tenant's links with 404", async () => {
    const a = await seed();
    const b = await seed();
    const docB = await uploaded(b, "tiny.pdf");
    const linkB = await shared(b, docB.id);

    expect((await share(a, { documentId: docB.id, expiresAt: Date.now() + DAY })).status).toBe(404);
    expect((await as(a, `/api/share-links?documentId=${docB.id}`)).status).toBe(404);
    expect(
      (await as(a, `/api/share-links/${linkB.link.id}/revoke`, { method: "POST" })).status,
    ).toBe(404);
    const own = await (await as(a, "/api/share-links")).json<{ links: ShareLinkInfo[] }>();
    expect(own.links).toEqual([]);
    expect((await visit(`/api/share/${linkB.token}`)).status).toBe(200);
  });
});
