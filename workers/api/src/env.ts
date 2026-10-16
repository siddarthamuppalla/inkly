import type { AuthEnv } from "@inkly/auth";

import type { DocSession } from "./doc-session.ts";

export interface Env extends AuthEnv {
  TEST_HOOKS_SECRET?: string;
  DOC_SESSIONS: DurableObjectNamespace<DocSession>;
}
