import type { Role } from "@inkly/auth";
import {
  FormFieldsResponse,
  type DocumentInfo,
  type FormField,
  type TenantId,
  type UserId,
} from "@inkly/domain";
import { readFormFields } from "@inkly/pdf";
import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { onAppError } from "../src/errors.ts";
import { formRoutes } from "../src/forms.ts";
import type { Env } from "../src/index.ts";
import type { TenantVars } from "../src/tenant-context.ts";
import { accessLog, as, hooks, json, seed, uploaded } from "./helpers.ts";

const VALUES = { full_name: "Ada Lovelace", email: "ada@example.test", agree: true };

async function fields(who: { token: string }, id: string): Promise<FormField[]> {
  const res = await as(who, `/api/documents/${id}/form`);
  expect(res.status).toBe(200);
  return FormFieldsResponse.parse(await res.json()).fields;
}

async function content(who: { token: string }, id: string): Promise<Uint8Array> {
  return new Uint8Array(await (await as(who, `/api/documents/${id}/content`)).arrayBuffer());
}

const valuesOf = (list: readonly FormField[]) =>
  Object.fromEntries(list.map((f) => [f.name, f.value]));

describe("GET /api/documents/:id/form", () => {
  it("lists the current Version's fields and logs the content read", async () => {
    const a = await seed();
    const doc = await uploaded(a, "forms.pdf");
    const list = await fields(a, doc.id);
    expect(list.map((f) => [f.name, f.type, f.value])).toEqual([
      ["full_name", "text", ""],
      ["email", "text", ""],
      ["agree", "checkbox", false],
    ]);
    expect(await accessLog(a.tenantId)).toEqual([
      expect.objectContaining({ action: "read-content", status: 200 }),
    ]);
  });

  it("returns no fields for a Document without a form", async () => {
    const a = await seed();
    const doc = await uploaded(a, "10p.pdf");
    expect(await fields(a, doc.id)).toEqual([]);
  });

  it("is 404 for an unknown Document", async () => {
    const a = await seed();
    expect((await as(a, "/api/documents/nope/form")).status).toBe(404);
  });
});

describe("POST /api/documents/:id/form", () => {
  it("saves the values as a new Version that reads them back", async () => {
    const a = await seed();
    const doc = await uploaded(a, "forms.pdf");
    const res = await as(a, `/api/documents/${doc.id}/form`, json("POST", { values: VALUES }));
    expect(res.status).toBe(201);
    const { document } = await res.json<{ document: DocumentInfo }>();
    expect(document).toMatchObject({ id: doc.id, currentVersion: 2, pages: 1 });
    expect(valuesOf(await fields(a, doc.id))).toEqual(VALUES);
    expect(valuesOf(await readFormFields(await content(a, doc.id)))).toEqual(VALUES);

    const v1 = await as(a, `/api/documents/${doc.id}/versions/1/content`);
    expect(valuesOf(await readFormFields(new Uint8Array(await v1.arrayBuffer())))).toEqual({
      full_name: "",
      email: "",
      agree: false,
    });
  });

  it("with flatten, the new Version has no form fields", async () => {
    const a = await seed();
    const doc = await uploaded(a, "forms.pdf");
    const res = await as(
      a,
      `/api/documents/${doc.id}/form`,
      json("POST", { values: VALUES, flatten: true }),
    );
    expect(res.status).toBe(201);
    expect(await fields(a, doc.id)).toEqual([]);
    expect(await readFormFields(await content(a, doc.id))).toEqual([]);
  });

  it("refuses an unknown field or an out-of-range value with 422 and adds no Version", async () => {
    const a = await seed();
    const doc = await uploaded(a, "forms.pdf");
    for (const body of [
      { values: { nickname: "x" } },
      { values: { agree: "yes" } },
      { values: "not an object" },
    ]) {
      const res = await as(a, `/api/documents/${doc.id}/form`, json("POST", body));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "invalid_input" });
    }
    const res = await as(a, `/api/documents/${doc.id}/form`, json("POST", { values: {} }));
    expect((await res.json<{ document: DocumentInfo }>()).document.currentVersion).toBe(2);
  });

  it("refuses a Document without a form with 422", async () => {
    const a = await seed();
    const doc = await uploaded(a, "tiny.pdf");
    const res = await as(a, `/api/documents/${doc.id}/form`, json("POST", { values: {} }));
    expect(res.status).toBe(422);
  });

  it("refuses with 402 when the new Version would pass the storage Limit", async () => {
    const a = await seed();
    const doc = await uploaded(a, "forms.pdf");
    // Usage is the sum of Version bytes; pretend Version 1 nearly fills the Free plan's 500 MB.
    // eslint-disable-next-line inkly/no-direct-bindings -- test setup for a Usage state no route can reach cheaply
    await env.DB.prepare("UPDATE document_versions SET bytes = ?1 WHERE tenant_id = ?2")
      .bind(500 * 1024 * 1024 - 100, a.tenantId)
      .run();
    const res = await as(a, `/api/documents/${doc.id}/form`, json("POST", { values: VALUES }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "limit_exceeded" });
    const versions = await (
      await as(a, `/api/documents/${doc.id}/versions`)
    ).json<{
      versions: unknown[];
    }>();
    expect(versions.versions).toHaveLength(1);
  });
});

function appAs(who: { tenantId: TenantId; userId: string }, role: Role) {
  const session = { tenantId: who.tenantId, userId: who.userId as UserId, role };
  const app = new Hono<{ Bindings: Env; Variables: TenantVars }>();
  app.onError(onAppError);
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("tenantId", who.tenantId);
    await next();
  });
  // formRoutes alone: its own role guard must hold without documentRoutes in front of it.
  app.route("/api/documents", formRoutes);
  return (path: string, init: RequestInit = {}) => app.request(path, init, hooks);
}

describe("roles and Tenants", () => {
  it("a viewer can read the form but POST is 403 and logged", async () => {
    const owner = await seed();
    const doc = await uploaded(owner, "forms.pdf");
    const viewer = appAs(owner, "viewer");
    expect((await viewer(`/api/documents/${doc.id}/form`)).status).toBe(200);
    const res = await viewer(`/api/documents/${doc.id}/form`, json("POST", { values: VALUES }));
    expect(res.status).toBe(403);
    expect((await accessLog(owner.tenantId)).map((e) => [e.action, e.status])).toEqual([
      ["read-content", 200],
      ["write", 403],
    ]);
    const editor = appAs(owner, "editor");
    const saved = await editor(`/api/documents/${doc.id}/form`, json("POST", { values: VALUES }));
    expect(saved.status).toBe(201);
  });

  it("another Tenant gets 404 on read and write, logged, and nothing changes", async () => {
    const a = await seed();
    const b = await seed();
    const doc = await uploaded(b, "forms.pdf");
    expect((await as(a, `/api/documents/${doc.id}/form`)).status).toBe(404);
    const res = await as(a, `/api/documents/${doc.id}/form`, json("POST", { values: VALUES }));
    expect(res.status).toBe(404);
    expect((await accessLog(a.tenantId)).map((e) => [e.action, e.status])).toEqual([
      ["read-content", 404],
      ["write", 404],
    ]);
    expect(valuesOf(await fields(b, doc.id))).toEqual({ full_name: "", email: "", agree: false });
  });
});
