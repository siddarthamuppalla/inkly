import { readAccessLog, readOutbox, seedAccount, testHooksOn } from "@inkly/auth";
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
  return testHooksOn(env) && secret.length > 0 && secretMatches(header, secret);
}

export const testHooks = new Hono<{ Bindings: Env }>();

testHooks.use("*", async (c, next) => {
  if (!testHooksEnabled(c.env, c.req.header("x-test-hooks-secret"))) return c.notFound();
  await next();
});

/**
 * Body (all optional): `{ email, name, plan: "free" | "pro" }`. Signs up a User through
 * packages/auth, so they own a fresh workspace, and returns a bearer token.
 */
testHooks.post("/seed", async (c) => {
  const body: unknown = await c.req.json().catch(() => ({}));
  const input = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const id = crypto.randomUUID().slice(0, 12);
  const email = typeof input["email"] === "string" ? input["email"] : `seed-${id}@seed.inkly.test`;
  const name = typeof input["name"] === "string" ? input["name"] : `Seed ${id}`;
  const plan = input["plan"] === "pro" ? "pro" : undefined;
  return c.json(await seedAccount(c.req.raw, c.env, { email, name, ...(plan && { plan }) }), 201);
});

// Lets verify-tenancy count the access-log entries its denied attempts produced.
testHooks.get("/access-log", async (c) => {
  const entries = await readAccessLog(c.env, c.req.query("tenant") ?? "");
  return entries ? c.json({ entries }) : c.json({ error: "tenant required" }, 400);
});

// Captured email for one address, newest first (Outbox, Q5).
testHooks.get("/outbox", async (c) => {
  const to = c.req.query("to") ?? "";
  if (!to.includes("@")) return c.json({ error: "to required" }, 400);
  return c.json({ messages: await readOutbox(c.env, to) });
});
