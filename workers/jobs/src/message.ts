import type { JobId, TenantId } from "@inkly/domain";

/** The body of every message on the Job queue: which Tenant's Job to run. */
export interface JobMessage {
  readonly tenantId: string;
  readonly jobId: string;
}

export function jobMessage(tenantId: TenantId, jobId: JobId): JobMessage {
  return { tenantId, jobId };
}
