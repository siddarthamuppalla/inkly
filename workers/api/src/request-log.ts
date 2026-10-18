import { loggablePath, logEvent, type RequestLog } from "@inkly/domain/log";
import type { MiddlewareHandler } from "hono";

export const REQUEST_ID_HEADER = "x-inkly-request-id";

/**
 * Logs every request when it starts and when it answers (#72). In `wrangler tail`, a
 * request that hung shows a `request_start` with no matching `request_end`, and the tail
 * event's own `outcome` (e.g. `canceled`) says how the invocation ended.
 */
export const requestLog: MiddlewareHandler = async (c, next) => {
  const requestId = c.req.header("cf-ray") ?? crypto.randomUUID();
  const line = { requestId, method: c.req.method, path: loggablePath(c.req.path) };
  const started = Date.now();
  const start: RequestLog = { event: "request_start", ...line };
  logEvent(start);
  await next();
  const end: RequestLog = {
    event: "request_end",
    ...line,
    status: c.res.status,
    ms: Date.now() - started,
  };
  logEvent(end);
  try {
    c.res.headers.set(REQUEST_ID_HEADER, requestId);
  } catch {
    // Immutable headers (a response passed through from a Durable Object, or a 101
    // upgrade): the log lines still carry the id.
  }
};
