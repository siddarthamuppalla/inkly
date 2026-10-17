#!/usr/bin/env bash
# cf-deploy-preview: per-PR preview environments on Cloudflare (Q9). See SKILL.md.
#
#   run.sh <pr>                 create or reuse inkly-pr-<pr> resources, migrate, deploy, print URL
#   run.sh --teardown <pr>      delete the Worker, D1, R2 bucket, KV namespace, Job queue and
#                               pdf-engine Container application for <pr>
#   run.sh --sweep              tear down every inkly-pr-* whose PR is closed (needs gh + GH_TOKEN)
#   run.sh --list <pr>          print the inkly-pr-<pr> resources that exist, one per line
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment, plus curl and jq.
# Deploy also needs a running Docker daemon: wrangler builds the pdf-engine image.
# Deploy writes the fresh TEST_HOOKS_SECRET to $PREVIEW_SECRET_FILE when set; it never prints it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=cf-lib.sh
source "$here/cf-lib.sh"

deploy() {
  local pr="$1" name="inkly-pr-$1" config secret url
  verify_token
  ensure_resources "$name"
  config="$(node "$here/preview-config.mjs" "$name" "$D1_ID" "$KV_ID")"
  pnpm --dir "$root" --filter @inkly/web build >/dev/null
  (cd "$api_dir" && "$wrangler" d1 migrations apply DB --remote -c "$config")
  (cd "$api_dir" && "$wrangler" deploy -c "$config")

  secret="$(openssl rand -hex 24)"
  printf '%s' "$secret" | (cd "$api_dir" && "$wrangler" secret put TEST_HOOKS_SECRET -c "$config") >/dev/null
  if [ -n "${PREVIEW_SECRET_FILE:-}" ]; then
    (umask 077 && printf '%s' "$secret" >"$PREVIEW_SECRET_FILE")
  fi
  ensure_random_secret "$name" "$config" BETTER_AUTH_SECRET

  url="$(workers_dev_url "$name")"

  wait_healthy "$url"
  echo "health: $(curl -s "$url/health")"
  echo "pr: $pr"
  echo "url: $url"
}

empty_bucket() {
  local name="$1" keys
  while :; do
    keys="$(cf GET "$acct/r2/buckets/$name/objects?per_page=1000" | jq -r '.result[].key')" || return 0
    [ -z "$keys" ] && return 0
    while IFS= read -r key; do
      cf DELETE "$acct/r2/buckets/$name/objects/$(jq -rn --arg k "$key" '$k|@uri')" >/dev/null
    done <<<"$keys"
  done
}

teardown() {
  local name="inkly-pr-$1" id
  if worker_exists "$name"; then
    cf DELETE "$acct/workers/scripts/$name?force=true" >/dev/null && echo "worker: deleted $name"
  fi
  id="$(d1_id "$name")"
  if [ -n "$id" ]; then cf DELETE "$acct/d1/database/$id" >/dev/null && echo "d1: deleted $name"; fi
  if r2_exists "$name"; then
    empty_bucket "$name"
    cf DELETE "$acct/r2/buckets/$name" >/dev/null && echo "r2: deleted $name"
  fi
  id="$(kv_id "$name")"
  if [ -n "$id" ]; then cf DELETE "$acct/storage/kv/namespaces/$id" >/dev/null && echo "kv: deleted $name"; fi
  id="$(queue_id "$name-jobs")"
  if [ -n "$id" ]; then cf DELETE "$acct/queues/$id" >/dev/null && echo "queue: deleted $name-jobs"; fi
  id="$(container_app_id "$name-pdfengine")"
  if [ -n "$id" ]; then
    cf DELETE "$acct/containers/applications/$id" >/dev/null && echo "container: deleted $name-pdfengine"
  fi
  echo "teardown: $name done"
}

list_one() {
  local name="inkly-pr-$1"
  if worker_exists "$name"; then echo "worker $name"; fi
  cf GET "$acct/d1/database?name=$name&per_page=100" | jq -r --arg n "$name" '.result[] | select(.name == $n) | "d1 \(.name) \(.uuid)"'
  if r2_exists "$name"; then echo "r2 $name"; fi
  cf GET "$acct/storage/kv/namespaces?per_page=100" | jq -r --arg n "$name" '.result[] | select(.title == $n) | "kv \(.title) \(.id)"'
  cf GET "$acct/queues?per_page=100" | jq -r --arg n "$name-jobs" '.result[] | select(.queue_name == $n) | "queue \(.queue_name) \(.queue_id)"'
  cf GET "$acct/containers/applications" | jq -r --arg n "$name-pdfengine" '.result[]? | select(.name == $n) | "container \(.name) \(.id)"'
}

sweep() {
  command -v gh >/dev/null || die "--sweep needs the gh CLI"
  local prs
  prs="$(
    {
      cf GET "$acct/workers/scripts" | jq -r '.result[].id'
      cf GET "$acct/d1/database?per_page=100" | jq -r '.result[].name'
      cf GET "$acct/r2/buckets?per_page=100" | jq -r '.result.buckets[]?.name'
      cf GET "$acct/storage/kv/namespaces?per_page=100" | jq -r '.result[].title'
      cf GET "$acct/queues?per_page=100" | jq -r '.result[].queue_name' | sed 's/-jobs$//'
    } | sed -n 's/^inkly-pr-\([0-9][0-9]*\)$/\1/p' | sort -un
  )"
  for pr in $prs; do
    state="$(gh pr view "$pr" --json state -q .state 2>/dev/null || echo UNKNOWN)"
    if [ "$state" = "OPEN" ]; then
      echo "sweep: keeping inkly-pr-$pr (open)"
    elif [ "$state" = "UNKNOWN" ]; then
      echo "sweep: skipping inkly-pr-$pr (could not read PR state)"
    else
      echo "sweep: inkly-pr-$pr is $state"
      teardown "$pr"
    fi
  done
}

case "${1:-}" in
  --teardown) check_pr "${2:-}"; teardown "$2" ;;
  --sweep) sweep ;;
  --list) check_pr "${2:-}"; list_one "$2" ;;
  --verify-token) verify_token ;;
  -h | --help | "") sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) check_pr "$1"; deploy "$1" ;;
esac
