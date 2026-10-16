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
  /** 401 and 429 only for Share-link visitors (wrong password, too many attempts). */
  readonly status: 401 | 403 | 404 | 429;
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
