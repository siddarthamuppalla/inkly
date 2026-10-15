import type { AuthEnv } from "@inkly/auth";

export interface Env extends AuthEnv {
  TEST_HOOKS_SECRET?: string;
}
