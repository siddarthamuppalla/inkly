#!/usr/bin/env bash
# verify-signing: one two-signer Envelope end to end, then check the sealed PDF and audit chain. See SKILL.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --disable-warning=ExperimentalWarning "$here/../../../packages/testing/bin/verify-signing.ts" "$@"
