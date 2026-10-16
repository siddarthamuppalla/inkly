import { mintJobId } from "@inkly/auth";
import {
  AppError,
  CompressRequest,
  isWellFormedId,
  type DocumentId,
  type JobId,
  type JobInfo,
} from "@inkly/domain";
import { jobMessage } from "@inkly/jobs";
import {
  createJob,
  failJob,
  getDocument,
  getJob,
  listDocumentJobs,
  requeueJob,
  type JobRow,
} from "@inkly/storage";
import { Hono } from "hono";

import type { Env } from "./env.ts";
import { parseJson } from "./errors.ts";
import { viewersReadOnly } from "./roles.ts";
import { denyAccess, type TenantContext, type TenantVars } from "./tenant-context.ts";
import { assertStorageFor } from "./upload.ts";

// Mounted at /api behind requireTenant: compress a Document, and read its Jobs.
export const jobRoutes = new Hono<{ Bindings: Env; Variables: TenantVars }>();

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,100}$/;

/** Longer than a Queue consumer may run, so an unfinished Job this old lost its delivery. */
const STALE_JOB_MS = 15 * 60_000;

export function jobInfo(job: JobRow): JobInfo {
  return {
    id: job.id,
    kind: job.kind,
    documentId: job.documentId,
    // `committing` is internal bookkeeping; to a user the Job is still running.
    status: job.status === "committing" ? "running" : job.status,
    level: job.input.level,
    fromVersion: job.input.fromVersion,
    output: job.output,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function missing(c: TenantContext, action: "read" | "write" | "list"): Promise<Response> {
  return denyAccess(c, action, `${c.req.method} ${c.req.path}`, 404);
}

async function findDocument(c: TenantContext) {
  const id = c.req.param("id") ?? "";
  return isWellFormedId(id) ? getDocument(c.get("tenantId"), c.env, id as DocumentId) : null;
}

async function enqueue(c: TenantContext, job: JobRow): Promise<void> {
  const tenantId = c.get("tenantId");
  try {
    await c.env.JOBS.send(jobMessage(tenantId, job.id));
  } catch (err) {
    await failJob(tenantId, c.env, job.id, "Compression couldn't start. Try again.");
    throw err;
  }
}

jobRoutes.post("/documents/:id/compress", viewersReadOnly, async (c) => {
  const tenantId = c.get("tenantId");
  const { level } = await parseJson(c.req.raw, CompressRequest);
  const doc = await findDocument(c);
  if (!doc) return missing(c, "write");
  if (doc.deletedAt !== null) {
    throw new AppError("conflict", "Restore this document from Trash before compressing it");
  }
  const key = c.req.header("idempotency-key");
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    throw new AppError("invalid_input", "Idempotency-Key must be 1–100 printable characters");
  }
  // The compressed Version is never larger than the one it replaces.
  await assertStorageFor(tenantId, c.env, doc.bytes);
  const { job, created } = await createJob(tenantId, c.env, {
    id: mintJobId(),
    // Without a client key, compressing the same Version at the same level is one Job.
    idempotencyKey:
      key === undefined
        ? `compress:${doc.id}:v${String(doc.currentVersion)}:${level}`
        : `client:${doc.id}:${key}`,
    documentId: doc.id,
    input: { level, fromVersion: doc.currentVersion },
    createdBy: c.get("session").userId,
  });
  if (created || (await requeueJob(tenantId, c.env, job.id, Date.now() - STALE_JOB_MS))) {
    await enqueue(c, job);
    const queued = await getJob(tenantId, c.env, job.id);
    return c.json({ job: jobInfo(queued ?? job) }, 202);
  }
  return c.json({ job: jobInfo(job) }, 200);
});

jobRoutes.get("/documents/:id/jobs", async (c) => {
  const doc = await findDocument(c);
  if (!doc) return missing(c, "list");
  const jobs = await listDocumentJobs(c.get("tenantId"), c.env, doc.id);
  return c.json({ jobs: jobs.map(jobInfo) });
});

jobRoutes.get("/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const job = isWellFormedId(id) ? await getJob(c.get("tenantId"), c.env, id as JobId) : null;
  return job ? c.json({ job: jobInfo(job) }) : missing(c, "read");
});
