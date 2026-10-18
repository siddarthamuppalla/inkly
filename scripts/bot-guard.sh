#!/usr/bin/env bash
# Decides whether a factory bot (docs/factory/05_BOTS.md) may run. Every check happens before any
# agent work. On go it writes run=true (pr-watcher adds pr=<n> and mode=fix|comment) to
# $GITHUB_OUTPUT; otherwise it writes one line to $GITHUB_STEP_SUMMARY and exits 0.
#
# Usage: bot-guard.sh verifier|triage|pr-watcher
# Env, all bots: FACTORY_PAUSED, HAS_TOKEN, GH_TOKEN/GH_REPO for gh.
# triage: ISSUE_LABELS (comma-separated labels the issue was opened with).
# pr-watcher: EVENT_NAME, GITHUB_REPOSITORY, HEAD_REPO, HEAD_BRANCH, PR_NUMBER (empty for
#   workflow_run: the PR is found by branch), SENDER_TYPE, AUTHOR_ASSOCIATION (the reviewer's).
set -euo pipefail

bot="${1:-}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
summary="${GITHUB_STEP_SUMMARY:-/dev/stderr}"
max_watcher_commits=3

say() { echo "$1" | tee -a "$summary" >&2; }
skip() {
  say "⏭️ $bot skipped: $1"
  exit 0
}

check_pause_and_token() {
  if [ "${FACTORY_PAUSED:-}" = "true" ] ||
    [ -n "$(gh issue list --label factory-pause --state open --json number -q '.[].number')" ]; then
    say "⏸️ $bot paused (factory-pause)"
    exit 0
  fi
  [ "${HAS_TOKEN:-}" = "true" ] || skip "CLAUDE_CODE_OAUTH_TOKEN is not set"
}

case "$bot" in
  verifier)
    check_pause_and_token
    echo "run=true" >>"$out"
    ;;
  triage)
    check_pause_and_token
    labels="${ISSUE_LABELS:-}"
    for label in ${labels//,/ }; do
      case "$label" in
        needs-info | ready-for-agent | ready-for-human | wontfix | needs-human) skip "already triaged ($label)" ;;
      esac
    done
    echo "run=true" >>"$out"
    ;;
  pr-watcher)
    # Event-shape filters first: no API call for events the watcher never handles.
    [ "${HEAD_REPO:-}" = "${GITHUB_REPOSITORY:?}" ] || skip "head is a fork (${HEAD_REPO:-})"
    case "${HEAD_BRANCH:-}" in
      t/?* | claude/?*) ;;
      *) skip "branch ${HEAD_BRANCH:-} is not t/* or claude/*" ;;
    esac
    if [ "${EVENT_NAME:-}" != "workflow_run" ]; then
      [ "${SENDER_TYPE:-}" != "Bot" ] || skip "review event from a bot"
      case "${AUTHOR_ASSOCIATION:-}" in
        OWNER | MEMBER | COLLABORATOR) ;;
        *) skip "reviewer is not a collaborator (${AUTHOR_ASSOCIATION:-})" ;;
      esac
    fi
    check_pause_and_token
    pr="$(gh pr view "${PR_NUMBER:-$HEAD_BRANCH}" --json number,state,labels,commits \
      -q '[.number, .state, ([.labels[].name] | index("risk:high") != null),
           ([.commits[] | select(.messageHeadline | startswith("pr-watcher:"))] | length)] | @tsv')"
    IFS=$'\t' read -r number state risk_high fixes <<<"$pr"
    [ "$state" = "OPEN" ] || skip "#$number is $state"
    [ "$fixes" -lt "$max_watcher_commits" ] || skip "#$number already has $fixes pr-watcher commits; needs a human"
    mode=fix
    if [ "$risk_high" = "true" ]; then
      mode=comment
      say "pr-watcher on #$number: risk:high, comment only"
    fi
    printf 'run=true\npr=%s\nmode=%s\n' "$number" "$mode" >>"$out"
    ;;
  *)
    echo "usage: bot-guard.sh verifier|triage|pr-watcher" >&2
    exit 2
    ;;
esac
