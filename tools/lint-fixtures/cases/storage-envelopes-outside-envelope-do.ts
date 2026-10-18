// lint-fixture target: workers/api/src/__lint_fixture__storage_envelopes_outside_do.ts
// lint-fixture expect: no-restricted-imports
import { commitEnvelope } from "@inkly/storage/envelopes";

export const write = commitEnvelope;
