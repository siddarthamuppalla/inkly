#!/usr/bin/env bash
# Shell tests for scripts/bot-guard.sh and scripts/triage-trust.sh, run by the `workflows` CI job.
# A stub `gh` on PATH serves canned JSON and applies the real --jq filter with jq.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
cat >"$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$GH_LOG"
case "$1 $2" in
  "issue list") json="${FAKE_ISSUES:-[]}" ;;
  "pr view") json="${FAKE_PR:-}" ;;
  "issue view") json="${FAKE_ISSUE:-}" ;;
  *) exit 0 ;;
esac
[ -n "$json" ] || { echo "stub gh: no fixture for $1 $2" >&2; exit 1; }
q="."
while [ $# -gt 0 ]; do
  case "$1" in -q | --jq) q="$2"; shift ;; esac
  shift
done
jq -r "$q" <<<"$json"
STUB
chmod +x "$work/bin/gh"

pass=0
fail=0
open_pr='{"number":7,"state":"OPEN","labels":[],"commits":[{"messageHeadline":"feat: x"}]}'

# Runs one guard invocation with a clean environment plus the given VAR=value pairs.
guard() {
  : >"$work/out"
  : >"$work/summary"
  : >"$work/gh.log"
  env -i PATH="$work/bin:$PATH" HOME="$HOME" GH_LOG="$work/gh.log" \
    GITHUB_OUTPUT="$work/out" GITHUB_STEP_SUMMARY="$work/summary" \
    HAS_TOKEN=true GITHUB_REPOSITORY=acme/inkly "$@" 2>/dev/null || echo "exit=$?" >>"$work/out"
}

expect() {
  local name="$1" want_out="$2" want_summary="$3"
  local out summary
  out="$(tr '\n' ' ' <"$work/out" | sed 's/ $//')"
  summary="$(cat "$work/summary")"
  if [ "$out" = "$want_out" ] && [[ "$summary" == *"$want_summary"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name"
    echo "  output:  [$out] want [$want_out]"
    echo "  summary: [$summary] want *$want_summary*"
  fi
}

watcher=(EVENT_NAME=workflow_run HEAD_REPO=acme/inkly HEAD_BRANCH=t/44-bots SENDER_TYPE=User "FAKE_PR=$open_pr")

for bot in verifier triage; do
  guard "$here/bot-guard.sh" "$bot"
  expect "$bot runs when clear" "run=true" ""
  guard FACTORY_PAUSED=true "$here/bot-guard.sh" "$bot"
  expect "$bot stops on FACTORY_PAUSED" "" "$bot paused (factory-pause)"
  guard 'FAKE_ISSUES=[{"number":3}]' "$here/bot-guard.sh" "$bot"
  expect "$bot stops on a factory-pause issue" "" "$bot paused (factory-pause)"
  guard HAS_TOKEN=false "$here/bot-guard.sh" "$bot"
  expect "$bot skips without token" "" "$bot skipped: CLAUDE_CODE_OAUTH_TOKEN is not set"
  guard FACTORY_PAUSED=true HAS_TOKEN=false "$here/bot-guard.sh" "$bot"
  expect "$bot reports pause before missing token" "" "$bot paused (factory-pause)"
done

guard ISSUE_LABELS=phase:2,ready-for-agent "$here/bot-guard.sh" triage
expect "triage skips an issue opened with a triage label" "" "triage skipped: already triaged (ready-for-agent)"
guard ISSUE_LABELS=needs-triage "$here/bot-guard.sh" triage
expect "triage runs on needs-triage" "run=true" ""

guard "${watcher[@]}" "$here/bot-guard.sh" pr-watcher
expect "watcher fixes a t/* PR" "run=true pr=7 mode=fix" ""
guard "${watcher[@]}" HEAD_BRANCH=claude/phase-2 "$here/bot-guard.sh" pr-watcher
expect "watcher fixes a claude/* PR" "run=true pr=7 mode=fix" ""
for branch in main feature/x t claude tx/1; do
  guard "${watcher[@]}" "HEAD_BRANCH=$branch" "$here/bot-guard.sh" pr-watcher
  expect "watcher ignores branch $branch" "" "pr-watcher skipped: branch $branch is not t/* or claude/*"
done
guard "${watcher[@]}" HEAD_REPO=mallory/inkly "$here/bot-guard.sh" pr-watcher
expect "watcher ignores forks" "" "pr-watcher skipped: head is a fork (mallory/inkly)"
guard "${watcher[@]}" HEAD_REPO= "$here/bot-guard.sh" pr-watcher
expect "watcher ignores an unknown head repo" "" "pr-watcher skipped: head is a fork ()"
guard "${watcher[@]}" FACTORY_PAUSED=true "$here/bot-guard.sh" pr-watcher
expect "watcher stops on FACTORY_PAUSED" "" "pr-watcher paused (factory-pause)"
guard "${watcher[@]}" 'FAKE_ISSUES=[{"number":3}]' "$here/bot-guard.sh" pr-watcher
expect "watcher stops on a factory-pause issue" "" "pr-watcher paused (factory-pause)"
guard "${watcher[@]}" HAS_TOKEN=false "$here/bot-guard.sh" pr-watcher
expect "watcher skips without token" "" "pr-watcher skipped: CLAUDE_CODE_OAUTH_TOKEN is not set"
guard "${watcher[@]}" 'FAKE_PR={"number":7,"state":"OPEN","labels":[{"name":"risk:high"}],"commits":[]}' \
  "$here/bot-guard.sh" pr-watcher
expect "watcher only comments on risk:high" "run=true pr=7 mode=comment" "pr-watcher on #7: risk:high, comment only"
guard "${watcher[@]}" 'FAKE_PR={"number":7,"state":"MERGED","labels":[],"commits":[]}' "$here/bot-guard.sh" pr-watcher
expect "watcher skips a PR that is not open" "" "pr-watcher skipped: #7 is MERGED"
three='{"messageHeadline":"pr-watcher: fix ci"}'
guard "${watcher[@]}" "FAKE_PR={\"number\":7,\"state\":\"OPEN\",\"labels\":[],\"commits\":[$three,$three,$three]}" \
  "$here/bot-guard.sh" pr-watcher
expect "watcher stops after three fixes" "" "pr-watcher skipped: #7 already has 3 pr-watcher commits; needs a human"
guard "${watcher[@]}" EVENT_NAME=pull_request_review_comment AUTHOR_ASSOCIATION=MEMBER PR_NUMBER=7 \
  "$here/bot-guard.sh" pr-watcher
expect "watcher answers a member's review comment" "run=true pr=7 mode=fix" ""
for who in NONE CONTRIBUTOR FIRST_TIME_CONTRIBUTOR ""; do
  guard "${watcher[@]}" EVENT_NAME=pull_request_review "AUTHOR_ASSOCIATION=$who" PR_NUMBER=7 \
    "$here/bot-guard.sh" pr-watcher
  expect "watcher ignores a review by '$who'" "" "pr-watcher skipped: reviewer is not a collaborator ($who)"
done
guard "${watcher[@]}" EVENT_NAME=pull_request_review_comment AUTHOR_ASSOCIATION=OWNER SENDER_TYPE=Bot PR_NUMBER=7 \
  "$here/bot-guard.sh" pr-watcher
expect "watcher ignores review comments from bots" "" "pr-watcher skipped: review event from a bot"
guard "${watcher[@]}" HEAD_BRANCH=main FACTORY_PAUSED=true "$here/bot-guard.sh" pr-watcher
if [ -s "$work/gh.log" ]; then
  fail=$((fail + 1))
  echo "FAIL: watcher calls gh before the branch filter: $(cat "$work/gh.log")"
else
  pass=$((pass + 1))
fi

guard "$here/bot-guard.sh" nonsense
expect "unknown bot exits 2 without a go" "exit=2" ""

# triage-trust.sh: only collaborators' issues may stay ready-for-agent.
tagged='{"labels":[{"name":"ready-for-agent"},{"name":"phase:2"}]}'
guard AUTHOR_ASSOCIATION=NONE "FAKE_ISSUE=$tagged" "$here/triage-trust.sh" 12
if grep -q -- 'gh issue edit 12 --remove-label ready-for-agent --add-label needs-triage' "$work/gh.log" &&
  grep -q -- 'gh issue comment 12' "$work/gh.log"; then pass=$((pass + 1)); else
  fail=$((fail + 1))
  echo "FAIL: untrusted ready-for-agent issue is not demoted: $(cat "$work/gh.log")"
fi
for who in OWNER MEMBER COLLABORATOR; do
  guard "AUTHOR_ASSOCIATION=$who" "FAKE_ISSUE=$tagged" "$here/triage-trust.sh" 12
  if grep -q 'issue edit' "$work/gh.log"; then
    fail=$((fail + 1))
    echo "FAIL: $who issue was demoted"
  else pass=$((pass + 1)); fi
done
guard AUTHOR_ASSOCIATION=NONE 'FAKE_ISSUE={"labels":[{"name":"needs-info"}]}' "$here/triage-trust.sh" 12
if grep -q 'issue edit' "$work/gh.log"; then
  fail=$((fail + 1))
  echo "FAIL: untrusted issue without ready-for-agent was edited"
else pass=$((pass + 1)); fi

echo "bot-guard tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
