import type { JobsEnv } from "@inkly/jobs";

import type { DocSession } from "./doc-session.ts";
import type { Envelope } from "./envelope/do.ts";

export interface Env extends JobsEnv {
  TEST_HOOKS_SECRET?: string;
  DOC_SESSIONS: DurableObjectNamespace<DocSession>;
  ENVELOPES: DurableObjectNamespace<Envelope>;
}
