#!/usr/bin/env bash
# Prints a new Document seal key pair (ADR-0006) for the Worker secrets SEAL_PRIVATE_KEY and
# SEAL_CERTIFICATE. Nothing is written to disk; paste each PEM into `wrangler secret put`,
# or pipe `--json` straight into `wrangler secret bulk`.
# usage: scripts/seal-key.sh [--subject NAME] [--json]
#   scripts/seal-key.sh --json | pnpm --filter @inkly/api exec wrangler secret bulk
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --disable-warning=ExperimentalWarning "$here/seal-key.mjs" "$@"
