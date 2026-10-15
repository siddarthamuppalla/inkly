// lint-fixture target: packages/auth/src/__lint_fixture__tenant_id_minted_in_auth.ts
// lint-fixture expect: none
import type { TenantId } from "@inkly/domain";

export function mint(raw: string): TenantId {
  return raw as TenantId;
}
