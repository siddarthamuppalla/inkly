// lint-fixture target: packages/auth/src/__lint_fixture__storage_envelopes_in_auth.ts
// lint-fixture expect: no-restricted-imports
import { claimEnvelope } from "@inkly/storage/envelopes";

export const claim = claimEnvelope;
