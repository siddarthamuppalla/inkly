import type {
  DocumentId,
  EnvelopeId,
  FieldId,
  JobId,
  RecipientId,
  TenantId,
  UserId,
} from "@inkly/domain";

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

/** A new JobId. */
export function mintJobId(): JobId {
  return newId("job") as JobId;
}

/** A new EnvelopeId. */
export function mintEnvelopeId(): EnvelopeId {
  return newId("env") as EnvelopeId;
}

/** A new RecipientId. */
export function mintRecipientId(): RecipientId {
  return newId("rcp") as RecipientId;
}

/** A new FieldId. */
export function mintFieldId(): FieldId {
  return newId("fld") as FieldId;
}
