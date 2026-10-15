// lint-fixture target: workers/api/src/__lint_fixture__storage_auth_outside_auth.ts
// lint-fixture expect: no-restricted-imports
import { listOutbox } from "@inkly/storage/auth";

export const read = listOutbox;
