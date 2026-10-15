declare const tenantIdBrand: unique symbol;
declare const documentIdBrand: unique symbol;
declare const userIdBrand: unique symbol;
declare const folderIdBrand: unique symbol;

/** A Tenant's identifier. Only `packages/auth` mints one, after a membership check (ADR-0004). */
export type TenantId = string & { readonly [tenantIdBrand]: true };

/** A Document's identifier, unique within its Tenant. */
export type DocumentId = string & { readonly [documentIdBrand]: true };

/** A Folder's identifier, unique within its Tenant. */
export type FolderId = string & { readonly [folderIdBrand]: true };

/** A User's identifier. Only `packages/auth` mints one. */
export type UserId = string & { readonly [userIdBrand]: true };

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** True when `raw` is safe to embed in an R2 key segment or SQL parameter as an id. */
export function isWellFormedId(raw: string): boolean {
  return ID_PATTERN.test(raw);
}
