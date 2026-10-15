// lint-fixture target: workers/api/src/__lint_fixture__tenant_id_minted_outside_auth.ts
// lint-fixture expect: inkly/no-tenant-id-mint
import type { TenantId } from "@inkly/domain";

export function forge(raw: string): TenantId {
  return raw as TenantId;
}
