import { authenticate } from "@inkly/auth";
import { Hono } from "hono";

import type { Env } from "./env.ts";

// Always 200, so the SPA can learn whether to load workspace data without a 401
// (which browsers report as a console error) for anonymous visitors.
export const sessionRoute = new Hono<{ Bindings: Env }>();

sessionRoute.get("/", async (c) => {
  const session = await authenticate(c.req.raw.headers, c.env);
  return c.json({ signedIn: session !== null });
});
