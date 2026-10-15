import { env } from "cloudflare:workers";
import type { TenantId } from "@inkly/domain";
import { getTenant } from "@inkly/storage";
import { describe, expect, it } from "vitest";

import app, { type Env } from "../src/index.ts";

// Random per run so no secret-shaped literal lives in the repo (gitleaks).
const SECRET = crypto.randomUUID();

function seed(bindings: Partial<Env>, secret?: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== undefined) headers["x-test-hooks-secret"] = secret;
  return app.request(
    "/__test/seed",
    { method: "POST", headers, ...(body !== undefined && { body: JSON.stringify(body) }) },
    { ...env, ...bindings },
  );
}

const enabled = { TEST_HOOKS: "enabled", TEST_HOOKS_SECRET: SECRET };

describe("test hooks", () => {
  it("seeds a fresh tenant, user and bearer session through packages/auth", async () => {
    const res = await seed(enabled, SECRET);
    expect(res.status).toBe(201);
    const body = await res.json<{
      tenantId: TenantId;
      userId: string;
      email: string;
      token: string;
    }>();
    expect(body.tenantId).toMatch(/^ten_[0-9a-f]{32}$/);
    expect(body.userId).toMatch(/^usr_[0-9a-f]{32}$/);
    expect(await getTenant(body.tenantId, env)).toMatchObject({ id: body.tenantId, plan: "free" });

    const me = await app.request(
      "/api/me",
      { headers: { authorization: `Bearer ${body.token}` } },
      { ...env, ...enabled },
    );
    expect(await me.json()).toMatchObject({
      user: { id: body.userId, email: body.email },
      activeTenant: { id: body.tenantId },
      role: "owner",
    });

    const again = await (await seed(enabled, SECRET)).json<{ tenantId: string }>();
    expect(again.tenantId).not.toBe(body.tenantId);
  });

  it("seeds a Pro tenant and a chosen email on request", async () => {
    const email = `chosen-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const res = await seed(enabled, SECRET, { email, plan: "pro" });
    const body = await res.json<{ tenantId: TenantId; email: string }>();
    expect(body.email).toBe(email);
    expect(await getTenant(body.tenantId, env)).toMatchObject({ plan: "pro" });
  });

  it("reads the Outbox for one address", async () => {
    const email = `outbox-${crypto.randomUUID().slice(0, 8)}@example.test`;
    await app.request(
      "http://inkly.test/api/auth/email-otp/send-verification-otp",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://inkly.test" },
        body: JSON.stringify({ email, type: "sign-in" }),
      },
      { ...env, ...enabled },
    );
    const read = (secret?: string) =>
      app.request(
        `/__test/outbox?to=${encodeURIComponent(email)}`,
        secret ? { headers: { "x-test-hooks-secret": secret } } : {},
        { ...env, ...enabled },
      );
    expect((await read()).status).toBe(404);
    const res = await read(SECRET);
    expect(res.status).toBe(200);
    const { messages } = await res.json<{ messages: { to: string; subject: string }[] }>();
    expect(messages).toEqual([
      expect.objectContaining({
        to: email,
        subject: expect.stringMatching(/sign-in code/) as string,
      }),
    ]);
  });

  it("returns 404 without the secret header", async () => {
    expect((await seed(enabled)).status).toBe(404);
  });

  it("returns 404 with a wrong secret, including one of a different length", async () => {
    const sameLength = `${SECRET.slice(0, -1)}${SECRET.endsWith("0") ? "1" : "0"}`;
    expect((await seed(enabled, sameLength)).status).toBe(404);
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
