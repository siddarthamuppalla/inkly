import { probeBindings } from "@inkly/storage/health";
import { Hono } from "hono";

import { account } from "./account.ts";
import { documentRoutes } from "./documents.ts";
import type { Env } from "./env.ts";
import { onAppError } from "./errors.ts";
import { folderRoutes } from "./folders.ts";
import { sharedRoutes, shareLinkRoutes } from "./share-links.ts";
import { requireTenant } from "./tenant-context.ts";
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
app.route("/api", account);
app.use("/api/documents/*", requireTenant);
app.route("/api/documents", documentRoutes);
app.use("/api/folders/*", requireTenant);
app.route("/api/folders", folderRoutes);
app.use("/api/share-links/*", requireTenant);
app.route("/api/share-links", shareLinkRoutes);
app.route("/api/share", sharedRoutes);

export default app;
