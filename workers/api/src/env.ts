import type { AuthEnv } from "@inkly/auth";

export interface Env extends AuthEnv {
  /** "enabled" only in local dev and preview environments (Q11). */
  TEST_HOOKS?: string;
  TEST_HOOKS_SECRET?: string;
}
