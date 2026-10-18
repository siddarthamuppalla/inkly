import type { JobsEnv } from "@inkly/jobs";

import type { DocSession } from "./doc-session.ts";
import type { Envelope } from "./envelope/do.ts";
import type { LifecycleParams } from "./envelope/lifecycle-event.ts";

export interface Env extends JobsEnv {
  TEST_HOOKS_SECRET?: string;
  DOC_SESSIONS: DurableObjectNamespace<DocSession>;
  ENVELOPES: DurableObjectNamespace<Envelope>;
  ENVELOPE_LIFECYCLE: Workflow<LifecycleParams>;
  /** The Document seal key (ADR-0006): a PKCS#8 PEM and its X.509 certificate's PEM. */
  SEAL_PRIVATE_KEY?: string;
  SEAL_CERTIFICATE?: string;
}
