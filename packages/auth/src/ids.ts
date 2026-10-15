import type { DocumentId, TenantId, UserId } from "@inkly/domain";

// ADR-0004: TenantId and UserId are minted only here. A TenantId for an existing
// tenant comes from session.ts, after the membership check.

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** A new, unused TenantId for a Tenant being created. */
export function mintTenantId(): TenantId {
  return newId("ten") as TenantId;
}

/** A new, unused UserId for a User being created. */
export function mintUserId(): UserId {
  return newId("usr") as UserId;
}

/** A new DocumentId. */
export function mintDocumentId(): DocumentId {
  return newId("doc") as DocumentId;
}
