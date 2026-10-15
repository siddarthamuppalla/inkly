// Structured logging (CLAUDE.md paved road). Phase 0 writes JSON lines to the
// runtime console; Workers Logs picks them up. No other I/O here.

declare const console: { log(line: string): void };

export type AccessAction = "read" | "write" | "list" | "read-content";

export interface AccessDenied {
  readonly event: "access_denied";
  /** The caller's own tenant. */
  readonly actorTenantId: string;
  readonly actorUserId: string;
  readonly action: AccessAction;
  readonly resource: string;
  readonly status: 403 | 404;
  readonly at: number;
}

export function accessDenied(fields: Omit<AccessDenied, "event" | "at">): AccessDenied {
  return { event: "access_denied", at: Date.now(), ...fields };
}

export function logEvent(event: { readonly event: string }): void {
  console.log(JSON.stringify(event));
}
