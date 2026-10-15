import type { TenantId, UserId } from "@inkly/domain";

// ADR-0004: TenantId and UserId are minted only here. Phase 1 adds the
// membership check that turns a session into an Active tenant's TenantId.

function newId(prefix: string): string {
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
