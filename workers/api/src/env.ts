import type { JobsEnv } from "@inkly/jobs";

import type { DocSession } from "./doc-session.ts";

export interface Env extends JobsEnv {
  TEST_HOOKS_SECRET?: string;
  DOC_SESSIONS: DurableObjectNamespace<DocSession>;
}
