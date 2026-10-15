import type { StorageEnv } from "@inkly/storage";

/** Bindings and settings `packages/auth` reads; a Worker's Env must include these. */
export interface AuthEnv extends StorageEnv {
  /** "enabled" only in local dev and preview environments (Q11). */
  TEST_HOOKS?: string;
  /** Self-test only: "leak" makes resolveTenant trust the client's tenant header. */
  VERIFY_TENANCY_SELFTEST?: string;
  /** Signs session cookies. Required outside test hooks. */
  BETTER_AUTH_SECRET?: string;
  /** Public origin, e.g. https://app.inkly.example. Defaults to the request's origin. */
  BETTER_AUTH_URL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** "outbox" | "resend" | "cloudflare". Defaults to "outbox" only when test hooks are on. */
  EMAIL_PROVIDER?: string;
  /** Sender address for every email Inkly sends. */
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** Cloudflare Email Service binding, used when EMAIL_PROVIDER is "cloudflare". */
  SEND_EMAIL?: SendEmail;
}

export function testHooksOn(env: AuthEnv): boolean {
  return env.TEST_HOOKS === "enabled";
}
