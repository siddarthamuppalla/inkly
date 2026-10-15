#!/usr/bin/env bash
# verify-tenancy: as tenant A, attack tenant B's data; every attempt must be denied. See SKILL.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --disable-warning=ExperimentalWarning "$here/../../../packages/testing/bin/verify-tenancy.ts" "$@"
