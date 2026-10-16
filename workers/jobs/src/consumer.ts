import { tenantOfQueuedJob } from "@inkly/auth";
import { isWellFormedId, type CompressOutput, type JobId, type TenantId } from "@inkly/domain";
import { accessGranted, logEvent } from "@inkly/domain/log";
import {
  abandonJobCommit,
  addVersion,
  appendAccessLog,
  beginJobCommit,
  completeJob,
  failJob,
  findCommittedVersion,
  getDocument,
  getJob,
  listVersions,
  openVersion,
  startJobAttempt,
  type JobRow,
} from "@inkly/storage";

import { EngineRefusal, engineFor, type Engine } from "./engine.ts";
import type { JobsEnv } from "./env.ts";
import type { JobMessage } from "./message.ts";

/** Deliveries per message: keep equal to `max_retries` + 1 in workers/api/wrangler.jsonc. */
export const MAX_DELIVERIES = 3;

const REFUSALS: Record<string, string> = {
  pdf_encrypted: "This PDF is password-protected, so it can't be compressed.",
  pdf_malformed: "This PDF is damaged, so it can't be compressed.",
  payload_too_large: "This PDF is too large to compress.",
};
const UNAVAILABLE = "Compression didn't finish. Try again in a few minutes.";

type Outcome = "done" | "retry";

type CommittingJob = JobRow & { status: "committing"; commitSha256: string };

function logJob(event: string, fields: Record<string, unknown> = {}): void {
  const line = { event, ...fields };
  logEvent(line);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sourceBytes(tenantId: TenantId, env: JobsEnv, job: JobRow): Promise<number> {
  const versions = await listVersions(tenantId, env, job.documentId);
  return versions.find((v) => v.n === job.input.fromVersion)?.bytes ?? 0;
}

function isCommitting(job: JobRow): job is CommittingJob {
  return job.status === "committing" && job.commitSha256 !== null;
}

/** Marks a committing Job succeeded when its Version landed. */
async function finishLandedCommit(
  tenantId: TenantId,
  env: JobsEnv,
  job: CommittingJob,
): Promise<boolean> {
  const landed = await findCommittedVersion(tenantId, env, job);
  if (!landed) return false;
  const output: CompressOutput = {
    version: landed.n,
    bytesBefore: await sourceBytes(tenantId, env, job),
    bytesAfter: landed.bytes,
  };
  await completeJob(tenantId, env, job.id, output, { commitSha256: job.commitSha256 });
  return true;
}

/**
 * Settles a Job another delivery left `committing`: true when its Version landed, otherwise
 * it goes back to `queued` for this delivery to run. Should that delivery still be alive, it
 * can no longer add its Version, because the next attempt takes the commit from it.
 */
async function settleCommit(
  tenantId: TenantId,
  env: JobsEnv,
  job: CommittingJob,
): Promise<boolean> {
  if (await finishLandedCommit(tenantId, env, job)) return true;
  await abandonJobCommit(tenantId, env, job.id, job.commitSha256);
  return false;
}

async function fail(tenantId: TenantId, env: JobsEnv, job: JobRow, error: string, cause: string) {
  logJob("job_failed", { tenantId, jobId: job.id, kind: job.kind, cause });
  await failJob(tenantId, env, job.id, error);
}

/**
 * Runs one compress Job. Safe to call any number of times for the same message: a Job
 * adds at most one Version, and a finished Job is left as it is.
 */
export async function runJob(
  env: JobsEnv,
  message: JobMessage,
  engine: Engine,
  lastDelivery: boolean,
): Promise<Outcome> {
  const tenantId = tenantOfQueuedJob(message.tenantId);
  if (!tenantId || !isWellFormedId(message.jobId)) {
    logJob("job_message_malformed");
    return "done";
  }
  const found = await getJob(tenantId, env, message.jobId as JobId);
  if (!found || found.status === "succeeded" || found.status === "failed") return "done";
  if (isCommitting(found) && (await settleCommit(tenantId, env, found))) return "done";

  const attempt = await startJobAttempt(tenantId, env, found.id);
  if (attempt === null) return "done";
  const job = { ...found, status: "running" as const, attempts: attempt };

  const doc = await getDocument(tenantId, env, job.documentId);
  const source = doc && (await openVersion(tenantId, env, doc.id, job.input.fromVersion));
  if (!doc || !source) {
    await fail(tenantId, env, job, "This version of the document no longer exists.", "missing");
    return "done";
  }
  // Every content read leaves a trace; the Job reads on behalf of the User who asked for it.
  const read = accessGranted({
    actorTenantId: tenantId,
    actorUserId: job.createdBy,
    action: "read-content",
    resource: `document ${doc.id} v${String(job.input.fromVersion)} (job ${job.id})`,
  });
  logEvent(read);
  await appendAccessLog(tenantId, env, read);

  let result;
  try {
    result = await engine.compress(source.object.body, source.object.size, job.input.level);
  } catch (err) {
    if (err instanceof EngineRefusal) {
      await fail(tenantId, env, job, REFUSALS[err.code] ?? UNAVAILABLE, err.code);
      return "done";
    }
    logJob("job_engine_error", { tenantId, jobId: job.id, message: String(err) });
    if (!lastDelivery) return "retry";
    await fail(tenantId, env, job, UNAVAILABLE, "engine_unavailable");
    return "done";
  }

  const bytesBefore = source.version.bytes;
  if (!result.compressed) {
    const output: CompressOutput = { version: null, bytesBefore, bytesAfter: bytesBefore };
    await completeJob(tenantId, env, job.id, output, { attempt });
    return "done";
  }

  const sha256 = await sha256Hex(result.body);
  // A newer delivery of this message owns the Job now; it adds the Version.
  if (!(await beginJobCommit(tenantId, env, job.id, attempt, sha256))) return "done";
  const committing = await getJob(tenantId, env, job.id);
  if (!committing || !isCommitting(committing)) return "done";
  try {
    const added = await addVersion(
      tenantId,
      env,
      job.documentId,
      { body: result.body, sha256, pages: source.version.pages, createdBy: job.createdBy },
      { jobId: job.id, attempt },
    );
    // A newer delivery took the commit while this one was writing; it adds the Version.
    if (!added) return "done";
  } catch (err) {
    if (await finishLandedCommit(tenantId, env, committing)) return "done";
    // This delivery owns the commit and knows it failed, so the next one need not wait.
    await abandonJobCommit(tenantId, env, job.id, sha256);
    throw err;
  }
  await finishLandedCommit(tenantId, env, committing);
  return "done";
}

/** The Queue handler: runs each message's Job, retrying with backoff on transient failures. */
export async function consumeJobs(
  batch: MessageBatch<JobMessage>,
  env: JobsEnv,
  engine: Engine = engineFor(env),
): Promise<void> {
  for (const message of batch.messages) {
    const lastDelivery = message.attempts >= MAX_DELIVERIES;
    let outcome: Outcome;
    try {
      outcome = await runJob(env, message.body, engine, lastDelivery);
    } catch (err) {
      logJob("job_error", { message: String(err), attempts: message.attempts });
      outcome = lastDelivery ? await giveUp(env, message.body) : "retry";
    }
    if (outcome === "retry") message.retry({ delaySeconds: 10 * message.attempts });
    else message.ack();
  }
}

/** After the last delivery threw: fails the Job so the user sees it, if it can still fail. */
async function giveUp(env: JobsEnv, message: JobMessage): Promise<Outcome> {
  const tenantId = tenantOfQueuedJob(message.tenantId);
  if (!tenantId || !isWellFormedId(message.jobId)) return "done";
  const jobId = message.jobId as JobId;
  try {
    const job = await getJob(tenantId, env, jobId);
    if (job && isCommitting(job) && (await finishLandedCommit(tenantId, env, job))) return "done";
    await failJob(tenantId, env, jobId, UNAVAILABLE);
  } catch (err) {
    logJob("job_error", { message: String(err), giveUp: true });
  }
  return "done";
}
