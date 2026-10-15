#!/usr/bin/env bash
# verify-perf: p50/p95 of PDF ops on 50p.pdf against perf-baseline.json. See SKILL.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --disable-warning=ExperimentalWarning "$here/../../../packages/testing/bin/verify-perf.ts" "$@"
