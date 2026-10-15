import { isAppError } from "@inkly/domain";
import { logEvent } from "@inkly/domain/log";
import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Maps a thrown AppError to its status and `{ error, message }` body; anything else is a 500. */
export const onAppError: ErrorHandler = (err, c) => {
  if (isAppError(err)) return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  const entry = { event: "unhandled_error", message: err.message, stack: err.stack };
  logEvent(entry);
  return c.json({ error: "internal", message: "Something went wrong" }, 500);
};
