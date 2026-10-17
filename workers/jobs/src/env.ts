import type { AuthEnv } from "@inkly/auth";

import type { PdfEngine } from "./container.ts";
import type { JobMessage } from "./message.ts";

/** Bindings the Job queue and its consumer need; workers/api's Env includes these. */
export interface JobsEnv extends AuthEnv {
  /** Producer for the Job queue (`inkly-jobs`, or `inkly-pr-N-jobs` on a preview). */
  JOBS: Queue<JobMessage>;
  /** The pdf-engine Container (containers/pdf-engine). */
  PDF_ENGINE: DurableObjectNamespace<PdfEngine>;
  /**
   * Local dev and verify-app only, honored only with test hooks on: a pdf-engine started
   * with `pnpm --filter @inkly/pdf-engine start`, used instead of the Container.
   */
  PDF_ENGINE_URL?: string;
}
