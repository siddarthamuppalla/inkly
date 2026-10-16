import type {
  CompressLevel,
  CompressOutput,
  DocumentId,
  JobId,
  TenantId,
  UserId,
} from "@inkly/domain";
import type { StorageEnv } from "./env.ts";

// Jobs (migration 0006). The state machine lives here so every caller moves a Job the same
// way: queued -> running -> committing -> succeeded, or failed before succeeded.

export type JobRowStatus = "queued" | "running" | "committing" | "succeeded" | "failed";

export interface CompressInput {
  level: CompressLevel;
  fromVersion: number;
}

export interface JobRow {
  id: JobId;
  kind: "compress";
  documentId: DocumentId;
  status: JobRowStatus;
  input: CompressInput;
  output: CompressOutput | null;
  error: string | null;
  attempts: number;
  commitSha256: string | null;
  committingAt: number | null;
  createdBy: UserId;
  createdAt: number;
  updatedAt: number;
}

interface RawJob extends Omit<JobRow, "input" | "output"> {
  input: string;
  output: string | null;
}

const JOB_SELECT = `SELECT id, kind, document_id AS documentId, status, input, output, error, attempts,
  commit_sha256 AS commitSha256, committing_at AS committingAt, created_by AS createdBy,
  created_at AS createdAt, updated_at AS updatedAt FROM jobs`;

function parse(raw: RawJob): JobRow {
  return {
    ...raw,
    input: JSON.parse(raw.input) as CompressInput,
    output: raw.output === null ? null : (JSON.parse(raw.output) as CompressOutput),
  };
}

export async function getJob(
  tenantId: TenantId,
  env: StorageEnv,
  id: JobId,
): Promise<JobRow | null> {
  const raw = await env.DB.prepare(`${JOB_SELECT} WHERE tenant_id = ?1 AND id = ?2`)
    .bind(tenantId, id)
    .first<RawJob>();
  return raw ? parse(raw) : null;
}

/** A Document's most recent Jobs, newest first. */
export async function listDocumentJobs(
  tenantId: TenantId,
  env: StorageEnv,
  documentId: DocumentId,
  limit = 10,
): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    `${JOB_SELECT} WHERE tenant_id = ?1 AND document_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT ?3`,
  )
    .bind(tenantId, documentId, limit)
    .all<RawJob>();
  return results.map(parse);
}

/**
 * Records a queued Job unless the Tenant already has one with `idempotencyKey`.
 * Returns the Job for that key and whether this call created it.
 */
export async function createJob(
  tenantId: TenantId,
  env: StorageEnv,
  job: {
    id: JobId;
    idempotencyKey: string;
    documentId: DocumentId;
    input: CompressInput;
    createdBy: UserId;
  },
): Promise<{ job: JobRow; created: boolean }> {
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO jobs (tenant_id, id, idempotency_key, kind, document_id, status, input, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'compress', ?4, 'queued', ?5, ?6, ?7, ?7)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
  )
    .bind(
      tenantId,
      job.id,
      job.idempotencyKey,
      job.documentId,
      JSON.stringify(job.input),
      job.createdBy,
      now,
    )
    .run();
  const raw = await env.DB.prepare(`${JOB_SELECT} WHERE tenant_id = ?1 AND idempotency_key = ?2`)
    .bind(tenantId, job.idempotencyKey)
    .first<RawJob>();
  if (!raw) throw new Error("job vanished after insert");
  return { job: parse(raw), created: res.meta.changes > 0 };
}

/** Puts a failed Job back in the queue. False when it is not failed. */
export async function requeueJob(tenantId: TenantId, env: StorageEnv, id: JobId): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', error = NULL, updated_at = ?3
     WHERE tenant_id = ?1 AND id = ?2 AND status = 'failed'`,
  )
    .bind(tenantId, id, Date.now())
    .run();
  return res.meta.changes > 0;
}

/**
 * Starts a new attempt on a queued or running Job and returns its number; null when the Job
 * is finished or committing. A later attempt supersedes an earlier one still in flight.
 */
export async function startJobAttempt(
  tenantId: TenantId,
  env: StorageEnv,
  id: JobId,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?3
     WHERE tenant_id = ?1 AND id = ?2 AND status IN ('queued', 'running')
     RETURNING attempts`,
  )
    .bind(tenantId, id, Date.now())
    .first<{ attempts: number }>();
  return row?.attempts ?? null;
}

/**
 * Claims the right to add the Job's Version: only the latest attempt wins, once.
 * Records the new bytes' sha256 so a redelivery can find the Version if this one crashes.
 */
export async function beginJobCommit(
  tenantId: TenantId,
  env: StorageEnv,
  id: JobId,
  attempt: number,
  sha256: string,
): Promise<boolean> {
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE jobs SET status = 'committing', commit_sha256 = ?4, committing_at = ?5, updated_at = ?5
     WHERE tenant_id = ?1 AND id = ?2 AND status = 'running' AND attempts = ?3`,
  )
    .bind(tenantId, id, attempt, sha256, now)
    .run();
  return res.meta.changes > 0;
}

/**
 * The Version a committing Job added, found by the sha256 it recorded; null when the
 * commit never reached D1.
 */
export async function findCommittedVersion(
  tenantId: TenantId,
  env: StorageEnv,
  job: JobRow,
): Promise<{ n: number; bytes: number } | null> {
  if (job.commitSha256 === null || job.committingAt === null) return null;
  return env.DB.prepare(
    `SELECT n, bytes FROM document_versions
     WHERE tenant_id = ?1 AND document_id = ?2 AND sha256 = ?3 AND created_at >= ?4
     ORDER BY n LIMIT 1`,
  )
    .bind(tenantId, job.documentId, job.commitSha256, job.committingAt)
    .first<{ n: number; bytes: number }>();
}

/** Returns a committing Job whose Version never landed to `queued`, so it runs again. */
export async function abandonJobCommit(
  tenantId: TenantId,
  env: StorageEnv,
  id: JobId,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', commit_sha256 = NULL, committing_at = NULL, updated_at = ?3
     WHERE tenant_id = ?1 AND id = ?2 AND status = 'committing'`,
  )
    .bind(tenantId, id, Date.now())
    .run();
}

/**
 * Marks a Job succeeded with its output. With `attempt`, only while that attempt is
 * still the running one (a Job that needed no new Version); without, only while committing.
 */
export async function completeJob(
  tenantId: TenantId,
  env: StorageEnv,
  id: JobId,
  output: CompressOutput,
  attempt?: number,
): Promise<boolean> {
  const owned =
    attempt === undefined ? "status = 'committing'" : `status = 'running' AND attempts = ?5`;
  const stmt = env.DB.prepare(
    `UPDATE jobs SET status = 'succeeded', output = ?3, error = NULL, updated_at = ?4
     WHERE tenant_id = ?1 AND id = ?2 AND ${owned}`,
  );
  const now = Date.now();
  const bound =
    attempt === undefined
      ? stmt.bind(tenantId, id, JSON.stringify(output), now)
      : stmt.bind(tenantId, id, JSON.stringify(output), now, attempt);
  return (await bound.run()).meta.changes > 0;
}

/** Marks a queued or running Job failed with `error`; never touches a committing or finished one. */
export async function failJob(
  tenantId: TenantId,
  env: StorageEnv,
  id: JobId,
  error: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', error = ?3, updated_at = ?4
     WHERE tenant_id = ?1 AND id = ?2 AND status IN ('queued', 'running')`,
  )
    .bind(tenantId, id, error, Date.now())
    .run();
}
