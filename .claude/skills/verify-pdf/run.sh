#!/usr/bin/env bash
# verify-pdf: structural and visual checks for PDFs. See SKILL.md.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --disable-warning=ExperimentalWarning "$here/../../../packages/testing/bin/verify-pdf.ts" "$@"
