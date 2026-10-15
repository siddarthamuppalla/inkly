import { AppError } from "@inkly/domain";
import { countWindowHit } from "@inkly/storage/auth";

import { getAuth } from "./better-auth.ts";
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
  if (CODE_REQUESTS.has(path)) {
    const email = await emailOf(request);
    if (email) await limitCodeRequests(env, email);
  }
  return getAuth(env, request.url).handler(request);
}
