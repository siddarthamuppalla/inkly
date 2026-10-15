import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import app, { type Env } from "../src/index.ts";

const SECRET = crypto.randomUUID();
const hooks: Env = { ...env, TEST_HOOKS: "enabled", TEST_HOOKS_SECRET: SECRET };

async function seed(bindings: Env = hooks) {
  const res = await app.request(
    "/__test/seed",
    { method: "POST", headers: { "x-test-hooks-secret": SECRET } },
    bindings,
  );
  return res.json<{ tenantId: string; token: string }>();
}

function as(who: { token: string }, path: string, init: RequestInit = {}, bindings: Env = hooks) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${who.token}`);
  return app.request(path, { ...init, headers }, bindings);
}

async function createDoc(who: { token: string }, title: string) {
  const res = await as(who, "/v0/stub-docs", { method: "POST", body: JSON.stringify({ title }) });
  return (await res.json<{ id: string }>()).id;
}

async function accessLog(tenantId: string) {
  const res = await app.request(
    `/__test/access-log?tenant=${tenantId}`,
    { headers: { "x-test-hooks-secret": SECRET } },
    hooks,
  );
  return (await res.json<{ entries: { action: string; status: number }[] }>()).entries;
}

describe("stub docs", () => {
  it("rejects requests without a valid session", async () => {
    expect((await app.request("/v0/stub-docs", {}, hooks)).status).toBe(401);
    expect((await as({ token: "f".repeat(64) }, "/v0/stub-docs")).status).toBe(401);
  });

  it("serves a tenant its own doc and content", async () => {
    const a = await seed();
    const id = await createDoc(a, "mine");
    expect((await as(a, `/v0/stub-docs/${id}`)).status).toBe(200);
    expect(await (await as(a, `/v0/stub-docs/${id}/content`)).text()).toBe("");
  });

  it("denies another tenant and logs each denial against the actor", async () => {
    const a = await seed();
    const b = await seed();
    const docB = await createDoc(b, "theirs");
    const statuses = [
      (await as(a, `/v0/stub-docs/${docB}`)).status,
      (await as(a, `/v0/stub-docs/${docB}`, { method: "PUT", body: '{"title":"x"}' })).status,
      (await as(a, `/v0/stub-docs/${docB}/content`)).status,
      (await as(a, `/v0/stub-docs?tenant=${b.tenantId}`)).status,
      (await as(a, `/v0/stub-docs/${docB}`, { headers: { "x-inkly-tenant": b.tenantId } })).status,
    ];
    expect(statuses).toEqual([404, 404, 404, 403, 403]);
    expect((await accessLog(a.tenantId)).map((e) => [e.action, e.status])).toEqual([
      ["read", 404],
      ["write", 404],
      ["read-content", 404],
      ["list", 403],
      ["read", 403],
    ]);
    expect(await accessLog(b.tenantId)).toEqual([]);
  });

  it("ignores the self-test leak switch when test hooks are off", async () => {
    const a = await seed();
    const b = await seed();
    const docB = await createDoc(b, "theirs");
    const leakyProd: Env = { ...env, VERIFY_TENANCY_SELFTEST: "leak" };
    const res = await as(
      a,
      `/v0/stub-docs/${docB}`,
      { headers: { "x-inkly-tenant": b.tenantId } },
      leakyProd,
    );
    expect(res.status).toBe(403);
  });
});
