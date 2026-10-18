import { AppError } from "@inkly/domain";
import { step } from "@inkly/domain/log";
import { countWindowHit } from "@inkly/storage/auth";

import { getAuth } from "./better-auth.ts";
import { withEmailFailures } from "./email-failures.ts";
import type { AuthEnv } from "./env.ts";

// `/api/auth/*`: only the Better-Auth endpoints the sign-in page needs are reachable.
// Organization changes go through Inkly's own routes (workspace.ts), which apply Plan
// Limits and return AppErrors.

const BASE_PATH = "/api/auth";

const ROUTES = new Set([
  "POST /email-otp/send-verification-otp",
  "POST /sign-in/email-otp",
  "POST /sign-in/magic-link",
  "GET /magic-link/verify",
  "POST /sign-in/social",
  "GET /callback/google",
  "POST /callback/google",
  "GET /get-session",
  "POST /sign-out",
]);

/** Endpoints that email a code or link; each counts against the per-email limit. */
const CODE_REQUESTS = new Set(["/email-otp/send-verification-otp", "/sign-in/magic-link"]);

export const CODE_REQUEST_LIMIT = 5;
export const CODE_REQUEST_WINDOW_MS = 10 * 60 * 1000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Throws `rate_limited` once an email has asked for more than 5 codes in 10 minutes. */
export async function limitCodeRequests(env: AuthEnv, email: string): Promise<void> {
  const key = `sign-in-code/${await sha256Hex(email.trim().toLowerCase())}`;
  const count = await countWindowHit(env, key, CODE_REQUEST_WINDOW_MS);
  if (count > CODE_REQUEST_LIMIT) {
    throw new AppError(
      "rate_limited",
      "Too many sign-in codes requested. Try again in 10 minutes.",
    );
  }
}

async function emailOf(request: Request): Promise<string | null> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  if (typeof body !== "object" || body === null || !("email" in body)) return null;
  return typeof body.email === "string" ? body.email : null;
}

export async function handleAuthRequest(request: Request, env: AuthEnv): Promise<Response> {
  const path = new URL(request.url).pathname.slice(BASE_PATH.length);
  if (!ROUTES.has(`${request.method} ${path}`)) {
    return Response.json({ error: "not_found", message: "Not found" }, { status: 404 });
  }
  const auth = getAuth(env, request.url);
  if (!CODE_REQUESTS.has(path)) return auth.handler(request);
  // Step markers (#72): a send that never answered on the preview stopped in one of these.
  const email = await step("read_email", () => emailOf(request));
  if (email) await step("rate_limit", () => limitCodeRequests(env, email));
  // Better-Auth swallows a failed send and answers success; surface it instead, so
  // the sign-in page never says "Check your email" for mail that was not sent.
  const { result, failed } = await step("auth_handler", () =>
    withEmailFailures(() => auth.handler(request)),
  );
  if (failed) {
    throw new AppError(
      "email_failed",
      "We couldn't send the email. Try again later, or continue with Google.",
    );
  }
  return result;
}
