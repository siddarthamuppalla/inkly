// Compress and Job status over the API (T1.4b).
import {
  ErrorResponse,
  JobListResponse,
  JobResponse,
  type CompressLevel,
  type JobInfo,
} from "@inkly/domain";

import { ApiError } from "./api.ts";

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(path, { ...init, credentials: "include" });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorResponse.safeParse(body);
    throw new ApiError(
      res.status,
      err.success ? err.data.error : "error",
      err.success ? (err.data.message ?? err.data.error) : res.statusText,
    );
  }
  return body;
}

export const jobsApi = {
  compress: async (documentId: string, level: CompressLevel): Promise<JobInfo> =>
    JobResponse.parse(
      await call(`/api/documents/${documentId}/compress`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ level }),
      }),
    ).job,
  job: async (id: string): Promise<JobInfo> => JobResponse.parse(await call(`/api/jobs/${id}`)).job,
  documentJobs: async (documentId: string): Promise<JobInfo[]> =>
    JobListResponse.parse(await call(`/api/documents/${documentId}/jobs`)).jobs,
};

export function jobFinished(job: JobInfo): boolean {
  return job.status === "succeeded" || job.status === "failed";
}
