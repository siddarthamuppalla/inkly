import { isWellFormedId, type TenantId } from "@inkly/domain";

// ADR-0004: a Queue consumer has no session. Only workers/api enqueues Jobs, after
// requireTenant resolved the TenantId it puts in the message, so the consumer trusts
// that TenantId and still scopes every read and write to it.

/** The TenantId a Job message carries; null when it is missing or malformed. */
export function tenantOfQueuedJob(raw: unknown): TenantId | null {
  return typeof raw === "string" && isWellFormedId(raw) ? (raw as TenantId) : null;
}

/**
 * The TenantId an EnvelopeLifecycle Workflow instance carries in its params. Only the
 * Envelope DO starts one, with the TenantId of the Envelope it writes, so the same trust holds.
 */
export function tenantOfLifecycle(raw: unknown): TenantId | null {
  return tenantOfQueuedJob(raw);
}
