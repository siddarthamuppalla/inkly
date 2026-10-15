import { isWellFormedId, type DocumentId, type TenantId } from "@inkly/domain";

/** The R2 prefix every object of one Tenant lives under: `t/{tenantId}/`. */
export function tenantPrefix(tenantId: TenantId): string {
  if (!isWellFormedId(tenantId)) throw new RangeError("malformed tenant id");
  return `t/${tenantId}/`;
}

/** The only place a document version's R2 key is built: `t/{tenantId}/d/{documentId}/v{n}`. */
export function versionKey(tenantId: TenantId, documentId: DocumentId, version: number): string {
  const prefix = tenantPrefix(tenantId);
  if (!isWellFormedId(documentId)) throw new RangeError("malformed document id");
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be >= 1");
  return `${prefix}d/${documentId}/v${String(version)}`;
}
