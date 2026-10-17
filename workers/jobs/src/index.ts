// workers/jobs: the Job queue's consumer and the pdf-engine Container class. The deployed
// Worker is workers/api, which exports both, so one deploy carries the API, the queue
// consumer and the Container (docs/tickets/phase-1.md T1.4b).
export { PdfEngine } from "./container.ts";
export { consumeJobs, MAX_DELIVERIES, runJob } from "./consumer.ts";
export { EngineRefusal, engineFor, type Compressed, type Engine } from "./engine.ts";
export type { JobsEnv } from "./env.ts";
export { jobMessage, type JobMessage } from "./message.ts";
