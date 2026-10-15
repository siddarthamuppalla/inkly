import type { StorageEnv } from "@inkly/storage";
import { probeBindings } from "@inkly/storage/health";
import { Hono } from "hono";

export type Env = StorageEnv;

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const bindings = await probeBindings(c.env);
  const ok = bindings.d1 && bindings.r2 && bindings.kv;
  return c.json({ ok, ...bindings }, ok ? 200 : 503);
});

export default app;
