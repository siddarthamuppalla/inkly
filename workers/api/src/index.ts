import { probeBindings } from "@inkly/storage/health";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import { testHooks } from "./test-hooks.ts";

export type { Env } from "./env.ts";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const bindings = await probeBindings(c.env);
  const ok = bindings.d1 && bindings.r2 && bindings.kv;
  return c.json({ ok, ...bindings }, ok ? 200 : 503);
});

app.route("/__test", testHooks);

export default app;
