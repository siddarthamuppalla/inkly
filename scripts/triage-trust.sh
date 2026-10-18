#!/usr/bin/env bash
# Runs after the Triage agent. Anyone can open an issue on this public repo, and the agent reads
# that text, so only a collaborator's issue may stay ready-for-agent; others go back to a human.
# Usage: triage-trust.sh <issue-number>. Env: AUTHOR_ASSOCIATION, GH_TOKEN, GH_REPO.
set -euo pipefail

issue="${1:?usage: triage-trust.sh <issue-number>}"
case "${AUTHOR_ASSOCIATION:-}" in
  OWNER | MEMBER | COLLABORATOR) exit 0 ;;
esac
ready="$(gh issue view "$issue" --json labels -q '[.labels[].name] | index("ready-for-agent") != null')"
[ "$ready" = "true" ] || exit 0
gh issue edit "$issue" --remove-label ready-for-agent --add-label needs-triage
gh issue comment "$issue" --body "Triage marked this ready-for-agent, but the author is not a collaborator, so a maintainer must confirm it first (docs/agents/triage-labels.md)."
echo "#$issue demoted to needs-triage: author is ${AUTHOR_ASSOCIATION:-unknown}" >>"${GITHUB_STEP_SUMMARY:-/dev/stderr}"
