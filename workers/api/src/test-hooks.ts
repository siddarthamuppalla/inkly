import { issueSession, mintTenantId, mintUserId } from "@inkly/auth";
import type { TenantId } from "@inkly/domain";
import { isWellFormedId } from "@inkly/domain";
import { createTenant, createUser, listAccessLog } from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";

// Q11: /__test/* exists only when TEST_HOOKS=enabled (local dev and previews) and
// every call carries the per-environment secret. Anything else is a plain 404 so
// the route is not advertised.

const encoder = new TextEncoder();

function secretMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = encoder.encode(given);
  const b = encoder.encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export function testHooksEnabled(env: Env, header: string | undefined): boolean {
  const secret = env.TEST_HOOKS_SECRET ?? "";
  return env.TEST_HOOKS === "enabled" && secret.length > 0 && secretMatches(header, secret);
}

export const testHooks = new Hono<{ Bindings: Env }>();

testHooks.use("*", async (c, next) => {
  if (!testHooksEnabled(c.env, c.req.header("x-test-hooks-secret"))) return c.notFound();
  await next();
});

testHooks.post("/seed", async (c) => {
  const tenantId = mintTenantId();
  const userId = mintUserId();
  const email = `${userId}@seed.inkly.test`;
  await createTenant(tenantId, c.env, `Seed ${tenantId}`);
  await createUser(tenantId, c.env, { id: userId, email });
  const token = await issueSession(tenantId, userId, c.env);
  return c.json({ tenantId, userId, email, token }, 201);
});

// Lets verify-tenancy count the access-log entries its denied attempts produced.
testHooks.get("/access-log", async (c) => {
  const tenant = c.req.query("tenant") ?? "";
  if (!isWellFormedId(tenant)) return c.json({ error: "tenant required" }, 400);
  return c.json({ entries: await listAccessLog(tenant as TenantId, c.env) });
});
