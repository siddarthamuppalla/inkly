// Structured logging (CLAUDE.md paved road). Phase 0 writes JSON lines to the
// runtime console; Workers Logs picks them up. No other I/O here.

declare const console: { log(line: string): void };

export type AccessAction = "read" | "write" | "list" | "read-content" | "unlock" | "download";

/** Set on entries written for a Share-link visitor rather than a signed-in Member. */
export interface LinkVisit {
  readonly shareLinkId?: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface AccessDenied extends LinkVisit {
  readonly event: "access_denied";
  /** The caller's own tenant. */
  readonly actorTenantId: string;
  readonly actorUserId: string;
  readonly action: AccessAction;
  readonly resource: string;
  /** The Document the entry concerns, when there is one (T2.4 activity). */
  readonly documentId?: string;
  /** 401, 422 and 429 only for Share-link visitors (wrong/invalid password, too many attempts). */
  readonly status: 401 | 403 | 404 | 422 | 429;
  readonly at: number;
}

export function accessDenied(fields: Omit<AccessDenied, "event" | "at">): AccessDenied {
  return { event: "access_denied", at: Date.now(), ...fields };
}

/** A successful read of tenant data that must leave a trace, e.g. every content read. */
export interface AccessGranted extends LinkVisit {
  readonly event: "access_granted";
  readonly actorTenantId: string;
  readonly actorUserId: string;
  readonly action: AccessAction;
  readonly resource: string;
  /** The Document the entry concerns, when there is one (T2.4 activity). */
  readonly documentId?: string;
  readonly status: 200;
  readonly at: number;
}

export function accessGranted(
  fields: Omit<AccessGranted, "event" | "at" | "status">,
): AccessGranted {
  return { event: "access_granted", status: 200, at: Date.now(), ...fields };
}

export function logEvent(event: { readonly event: string }): void {
  console.log(JSON.stringify(event));
}

/** One line when the API Worker starts a request and one when it answers (#72). */
export interface RequestLog {
  readonly event: "request_start" | "request_end";
  /** Also sent back as the `x-inkly-request-id` response header. */
  readonly requestId: string;
  readonly method: string;
  /** Path only, with secrets replaced: see {@link loggablePath}. */
  readonly path: string;
  readonly status?: number;
  readonly ms?: number;
}

/** A request path safe to log: no query string, and Share-link tokens replaced. */
export function loggablePath(path: string): string {
  return path
    .replace(/^\/api\/share\/[^/]+/, "/api/share/:token")
    .replace(/^\/s\/[^/]+/, "/s/:token");
}

/**
 * Markers around one awaited step of a request (#72). In a `wrangler tail` event, a
 * `step_start` with no matching `step_end` or `step_error` is where a hung request stopped.
 */
export interface StepLog {
  readonly event: "step_start" | "step_end" | "step_error";
  readonly step: string;
  readonly ms?: number;
}

/** Runs `run`, logging a {@link StepLog} line before it and when it settles. */
export async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const start: StepLog = { event: "step_start", step: name };
  logEvent(start);
  try {
    const result = await run();
    const end: StepLog = { event: "step_end", step: name, ms: Date.now() - started };
    logEvent(end);
    return result;
  } catch (err) {
    const failed: StepLog = { event: "step_error", step: name, ms: Date.now() - started };
    logEvent(failed);
    throw err;
  }
}
