import { consumeJobs, type JobMessage } from "@inkly/jobs";
import { probeBindings } from "@inkly/storage/health";
import { Hono } from "hono";

import { account } from "./account.ts";
import { documentRoutes } from "./documents.ts";
import type { Env } from "./env.ts";
import { onAppError } from "./errors.ts";
import { folderRoutes } from "./folders.ts";
import { jobRoutes } from "./jobs.ts";
import { pageOpRoutes } from "./page-ops.ts";
import { requireTenant } from "./tenant-context.ts";
import { testHooks } from "./test-hooks.ts";

export type { Env } from "./env.ts";
export { PdfEngine } from "@inkly/jobs";

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
app.route("/api/documents", pageOpRoutes);
app.route("/api/documents", documentRoutes);
app.use("/api/folders/*", requireTenant);
app.route("/api/folders", folderRoutes);
app.use("/api/jobs/*", requireTenant);
app.route("/api", jobRoutes);

// verify-app fails a full run when one of these routes got no successful request from any
// journey. Registered after the `/__test` guard, so it is a 404 without the secret.
app.get("/__test/routes", (c) => {
  const routes = new Map(
    app.routes
      .filter((r) => r.method !== "ALL" && !r.path.startsWith("/__test"))
      .map((r) => [`${r.method} ${r.path}`, { method: r.method, path: r.path }]),
  );
  return c.json({ routes: [...routes.values()] });
});

export default {
  fetch: app.fetch,
  // Lets tests drive the app in-process, as Hono's app.request.
  request: app.request,
  queue: (batch, env) => consumeJobs(batch, env),
} satisfies ExportedHandler<Env, JobMessage> & Pick<typeof app, "request">;
