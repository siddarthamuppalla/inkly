#!/usr/bin/env bash
# cf-deploy-preview: per-PR preview environments on Cloudflare (Q9). See SKILL.md.
#
#   run.sh <pr>                 create or reuse inkly-pr-<pr> resources, migrate, deploy, print URL
#   run.sh --teardown <pr>      delete the Worker, D1, R2 bucket and KV namespace for <pr>
#   run.sh --sweep              tear down every inkly-pr-* whose PR is closed (needs gh + GH_TOKEN)
#   run.sh --list <pr>          print the inkly-pr-<pr> resources that exist, one per line
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment, plus curl and jq.
# Deploy writes the fresh TEST_HOOKS_SECRET to $PREVIEW_SECRET_FILE when set; it never prints it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
api_dir="$root/workers/api"
wrangler="$api_dir/node_modules/.bin/wrangler"
export WRANGLER_SEND_METRICS=false

die() { echo "cf-deploy-preview: $*" >&2; exit 1; }

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set (see scripts/setup-cloudflare-secrets.sh)}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set (see scripts/setup-cloudflare-secrets.sh)}"
command -v jq >/dev/null || die "jq is required"

acct="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"

# cf METHOD URL [JSON-BODY] -> prints the response body; fails on success=false.
cf() {
  local method="$1" url="$2" body="${3:-}" out
  if [ -n "$body" ]; then
    out="$(curl -sS -X "$method" "$url" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" --data "$body")"
  else
    out="$(curl -sS -X "$method" "$url" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")"
  fi
  if [ "$(jq -r '.success // false' <<<"$out" 2>/dev/null)" != "true" ]; then
    echo "$method ${url#"$acct"} failed: $(jq -c '.errors // .' <<<"$out" 2>/dev/null || echo "$out")" >&2
    return 1
  fi
  printf '%s' "$out"
}

verify_token() {
  if cf GET "$acct/tokens/verify" >/dev/null 2>&1 \
    || cf GET "https://api.cloudflare.com/client/v4/user/tokens/verify" >/dev/null 2>&1; then
    echo "token: valid"
  else
    die "the Cloudflare API token was rejected (check CLOUDFLARE_API_TOKEN)"
  fi
}

check_pr() { [[ "${1:-}" =~ ^[0-9]+$ ]] || die "PR number required, got '${1:-}'"; }

d1_id() { cf GET "$acct/d1/database?name=$1&per_page=100" | jq -r --arg n "$1" '.result[] | select(.name == $n) | .uuid' | head -n1; }
kv_id() { cf GET "$acct/storage/kv/namespaces?per_page=100" | jq -r --arg n "$1" '.result[] | select(.title == $n) | .id' | head -n1; }
r2_exists() { cf GET "$acct/r2/buckets/$1" >/dev/null 2>&1; }
worker_exists() { cf GET "$acct/workers/scripts" | jq -e --arg n "$1" '.result[] | select(.id == $n)' >/dev/null; }

ensure_resources() {
  local name="$1" id
  id="$(d1_id "$name")"
  if [ -z "$id" ]; then
    id="$(cf POST "$acct/d1/database" "{\"name\":\"$name\"}" | jq -r '.result.uuid')"
    echo "d1: created $name ($id)" >&2
  else
    echo "d1: reusing $name ($id)" >&2
  fi
  D1_ID="$id"

  if r2_exists "$name"; then
    echo "r2: reusing $name" >&2
  else
    cf POST "$acct/r2/buckets" "{\"name\":\"$name\"}" >/dev/null
    echo "r2: created $name" >&2
  fi

  id="$(kv_id "$name")"
  if [ -z "$id" ]; then
    id="$(cf POST "$acct/storage/kv/namespaces" "{\"title\":\"$name\"}" | jq -r '.result.id')"
    echo "kv: created $name ($id)" >&2
  else
    echo "kv: reusing $name ($id)" >&2
  fi
  KV_ID="$id"
}

deploy() {
  local pr="$1" name="inkly-pr-$1" config secret subdomain url
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
  # Signs this preview's session cookies (ADR-0003); never leaves Cloudflare.
  openssl rand -hex 32 | (cd "$api_dir" && "$wrangler" secret put BETTER_AUTH_SECRET -c "$config") >/dev/null

  subdomain="$(cf GET "$acct/workers/subdomain" | jq -r '.result.subdomain')"
  if [ -z "$subdomain" ] || [ "$subdomain" = "null" ]; then
    die "no workers.dev subdomain; open Workers & Pages in the Cloudflare dashboard once"
  fi
  url="https://$name.$subdomain.workers.dev"

  # A new workers.dev route reaches Cloudflare's edge unevenly: one 200 can be followed
  # by a 404 from a machine that hasn't seen the Worker yet (seen on the first deploy of
  # PR #22). Wait for several 200s in a row before handing the URL to the verifiers.
  local status="" streak=0
  for _ in $(seq 1 60); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$url/health" || true)"
    if [ "$status" = "200" ]; then streak=$((streak + 1)); else streak=0; fi
    [ "$streak" -ge 5 ] && break
    sleep 2
  done
  [ "$streak" -ge 5 ] || die "$url/health not stable after deploy (last status $status)"
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
  echo "teardown: $name done"
}

list_one() {
  local name="inkly-pr-$1"
  if worker_exists "$name"; then echo "worker $name"; fi
  cf GET "$acct/d1/database?name=$name&per_page=100" | jq -r --arg n "$name" '.result[] | select(.name == $n) | "d1 \(.name) \(.uuid)"'
  if r2_exists "$name"; then echo "r2 $name"; fi
  cf GET "$acct/storage/kv/namespaces?per_page=100" | jq -r --arg n "$name" '.result[] | select(.title == $n) | "kv \(.title) \(.id)"'
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
