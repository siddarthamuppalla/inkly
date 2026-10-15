#!/usr/bin/env bash
# verify-app: drives feature-map journeys in Chromium against wrangler dev or a URL. See SKILL.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --disable-warning=ExperimentalWarning "$here/../../../packages/testing/bin/verify-app.ts" "$@"
