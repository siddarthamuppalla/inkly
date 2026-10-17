import type { JobsEnv } from "@inkly/jobs";

export interface Env extends JobsEnv {
  TEST_HOOKS_SECRET?: string;
}
