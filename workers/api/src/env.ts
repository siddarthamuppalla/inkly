import type { StorageEnv } from "@inkly/storage";

export interface Env extends StorageEnv {
  /** "enabled" only in local dev and preview environments (Q11). */
  TEST_HOOKS?: string;
  TEST_HOOKS_SECRET?: string;
}
