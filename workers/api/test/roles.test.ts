import type { Role } from "@inkly/auth";
import type { TenantId, UserId } from "@inkly/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { documentRoutes } from "../src/documents.ts";
import { onAppError } from "../src/errors.ts";
import { folderRoutes } from "../src/folders.ts";
import type { Env } from "../src/index.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { accessLog, fixture, folder, hooks, json, seed, uploaded } from "./helpers.ts";

// A viewer Member is injected directly: seeding always makes an owner.

function appAs(who: { tenantId: TenantId; userId: string }, role: Role) {
  const session = { tenantId: who.tenantId, userId: who.userId as UserId, role };
  const app = new Hono<{ Bindings: Env; Variables: TenantVars }>();
  app.onError(onAppError);
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("tenantId", who.tenantId);
    await next();
  });
  app.route("/api/documents", documentRoutes);
  app.route("/api/folders", folderRoutes);
  return (path: string, init: RequestInit = {}) => app.request(path, init, hooks);
}

describe("a viewer Member", () => {
  it("gets 403 (logged) for upload, delete and move, and can still read", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "tiny.pdf");
    const target = await folder(owner, "Target");
    const viewer = appAs(owner, "viewer");

    const statuses = [
      (await viewer("/api/documents?filename=x.pdf", { method: "POST", body: fixture("tiny.pdf") }))
        .status,
      (await viewer(`/api/documents/${doc.id}`, { method: "DELETE" })).status,
      (await viewer(`/api/documents/${doc.id}`, json("PATCH", { folderId: target.id }))).status,
      (await viewer("/api/folders", json("POST", { name: "Nope" }))).status,
    ];
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect((await accessLog(owner.tenantId)).map((e) => [e.action, e.status])).toEqual([
      ["write", 403],
      ["write", 403],
      ["write", 403],
      ["write", 403],
    ]);

    expect((await viewer(`/api/documents/${doc.id}`)).status).toBe(200);
    expect((await viewer("/api/documents")).status).toBe(200);
  });

  it("lets an editor upload", async () => {
    const owner = await seed();
    const editor = appAs(owner, "editor");
    const res = await editor("/api/documents?filename=x.pdf", {
      method: "POST",
      body: fixture("tiny.pdf"),
    });
    expect(res.status).toBe(201);
  });
});
