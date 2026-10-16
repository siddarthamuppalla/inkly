import { AppError, isAppError } from "@inkly/domain";
import { logEvent } from "@inkly/domain/log";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** Maps a thrown AppError to its JSON response; anything else is a logged 500. */
export const onAppError: ErrorHandler = (err, c) => {
  if (isAppError(err)) return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  if (err instanceof HTTPException) return err.getResponse();
  const event = { event: "unhandled_error", message: err.message, stack: err.stack ?? "" };
  logEvent(event);
  return c.json({ error: "internal", message: "Something went wrong" }, 500);
};

/** Parses a JSON request body with a shared schema, or throws `invalid_input`. */
export async function parseJson<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.output<S>> {
  const raw: unknown = await req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Invalid request body");
  }
  return parsed.data;
}
