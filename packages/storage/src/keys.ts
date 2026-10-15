import { isWellFormedId, type DocumentId, type TenantId } from "@inkly/domain";

/** The only place a document version's R2 key is built: `t/{tenantId}/d/{documentId}/v{n}`. */
export function versionKey(tenantId: TenantId, documentId: DocumentId, version: number): string {
  if (!isWellFormedId(tenantId)) throw new RangeError("malformed tenant id");
  if (!isWellFormedId(documentId)) throw new RangeError("malformed document id");
  if (!Number.isSafeInteger(version) || version < 1) throw new RangeError("version must be >= 1");
  return `t/${tenantId}/d/${documentId}/v${String(version)}`;
}
