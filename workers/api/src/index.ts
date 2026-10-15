import { probeBindings } from "@inkly/storage/health";
import { Hono } from "hono";

import { account } from "./account.ts";
import { onAppError } from "./app-error.ts";
import type { Env } from "./env.ts";
import { stubDocs } from "./stub-docs.ts";
import { testHooks } from "./test-hooks.ts";

export type { Env } from "./env.ts";

const app = new Hono<{ Bindings: Env }>();

app.onError(onAppError);

app.get("/health", async (c) => {
  const bindings = await probeBindings(c.env);
  const ok = bindings.d1 && bindings.r2 && bindings.kv;
  return c.json({ ok, ...bindings }, ok ? 200 : 503);
});

app.route("/__test", testHooks);
app.route("/v0/stub-docs", stubDocs);
app.route("/api", account);

export default app;
