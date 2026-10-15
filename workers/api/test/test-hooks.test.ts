import { env } from "cloudflare:workers";
import type { TenantId, UserId } from "@inkly/domain";
import { getTenant, getUser } from "@inkly/storage";
import { describe, expect, it } from "vitest";

import app, { type Env } from "../src/index.ts";

const SECRET = "test-secret-0123456789";

function seed(bindings: Partial<Env>, secret?: string) {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers["x-test-hooks-secret"] = secret;
  return app.request("/__test/seed", { method: "POST", headers }, { ...env, ...bindings });
}

const enabled = { TEST_HOOKS: "enabled", TEST_HOOKS_SECRET: SECRET };

describe("test hooks", () => {
  it("seeds a fresh tenant and user through packages/storage", async () => {
    const res = await seed(enabled, SECRET);
    expect(res.status).toBe(201);
    const body = await res.json<{ tenantId: TenantId; userId: UserId; email: string }>();
    expect(body.tenantId).toMatch(/^ten_[0-9a-f]{32}$/);
    expect(body.userId).toMatch(/^usr_[0-9a-f]{32}$/);
    expect(await getTenant(body.tenantId, env)).toMatchObject({ id: body.tenantId, plan: "free" });
    expect(await getUser(body.tenantId, env, body.userId)).toMatchObject({ email: body.email });

    const again = await (await seed(enabled, SECRET)).json<{ tenantId: string }>();
    expect(again.tenantId).not.toBe(body.tenantId);
  });

  it("returns 404 without the secret header", async () => {
    expect((await seed(enabled)).status).toBe(404);
  });

  it("returns 404 with a wrong secret, including one of a different length", async () => {
    expect((await seed(enabled, "test-secret-0123456788")).status).toBe(404);
    expect((await seed(enabled, "x")).status).toBe(404);
  });

  it("returns 404 when TEST_HOOKS is not set, even with the right secret", async () => {
    expect((await seed({ TEST_HOOKS_SECRET: SECRET }, SECRET)).status).toBe(404);
    expect((await seed({ TEST_HOOKS: "disabled", TEST_HOOKS_SECRET: SECRET }, SECRET)).status).toBe(
      404,
    );
  });

  it("returns 404 when TEST_HOOKS is enabled but no secret is configured", async () => {
    expect((await seed({ TEST_HOOKS: "enabled" }, "")).status).toBe(404);
  });

  it("is off in the Worker as configured by wrangler.jsonc", async () => {
    expect(env.TEST_HOOKS).toBeUndefined();
    const res = await app.request(
      "/__test/seed",
      { method: "POST", headers: { "x-test-hooks-secret": SECRET } },
      env,
    );
    expect(res.status).toBe(404);
  });
});
