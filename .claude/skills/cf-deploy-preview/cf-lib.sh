#!/usr/bin/env bash
# Shared Cloudflare helpers for cf-deploy-preview/run.sh and scripts/deploy-production.sh.
# Source it; it sets: here, root, api_dir, wrangler, acct, and the functions below.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
api_dir="$root/workers/api"
wrangler="$api_dir/node_modules/.bin/wrangler"
export WRANGLER_SEND_METRICS=false

die() { echo "${0##*/}: $*" >&2; exit 1; }

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
queue_id() { cf GET "$acct/queues?per_page=100" | jq -r --arg n "$1" '.result[] | select(.queue_name == $n) | .queue_id' | head -n1; }
# Container applications are named <worker>-<class>, e.g. inkly-pr-12-pdfengine.
container_app_id() { cf GET "$acct/containers/applications" | jq -r --arg n "$1" '.result[]? | select(.name == $n) | .id' | head -n1; }
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

  # The Job queue (T1.4b). The Worker is both its producer and its consumer.
  id="$(queue_id "$name-jobs")"
  if [ -z "$id" ]; then
    cf POST "$acct/queues" "{\"queue_name\":\"$name-jobs\"}" >/dev/null
    echo "queue: created $name-jobs" >&2
  else
    echo "queue: reusing $name-jobs" >&2
  fi
}


# workers_dev_url NAME -> https://NAME.<account subdomain>.workers.dev
workers_dev_url() {
  local subdomain
  subdomain="$(cf GET "$acct/workers/subdomain" | jq -r '.result.subdomain')"
  if [ -z "$subdomain" ] || [ "$subdomain" = "null" ]; then
    die "no workers.dev subdomain; open Workers & Pages in the Cloudflare dashboard once"
  fi
  printf 'https://%s.%s.workers.dev' "$1" "$subdomain"
}

# wait_healthy URL: returns once URL/health has answered 200 ten times in a row.
wait_healthy() {
  local url="$1"
  # A new workers.dev route reaches Cloudflare's edge unevenly: one 200 can be followed
  # by a 404 from a machine that hasn't seen the Worker yet (seen on the first deploy of
  # PR #22, and again after five 200s on PR #34). Wait for ten 200s in a row, about 20
  # seconds, before handing the URL to the verifiers.
  local status="" streak=0
  for _ in $(seq 1 90); do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$url/health" || true)"
    if [ "$status" = "200" ]; then streak=$((streak + 1)); else streak=0; fi
    [ "$streak" -ge 10 ] && break
    sleep 2
  done
  [ "$streak" -ge 10 ] || die "$url/health not stable after deploy (last status $status)"
}

# ensure_random_secret WORKER CONFIG NAME: sets Worker secret NAME to random hex unless it
# already exists, so long-lived secrets (session signing keys) survive redeploys. Reads the list
# from the API, not `wrangler secret list`, whose stdout carries config warnings; a list it
# cannot read stops the deploy instead of replacing the secret.
ensure_random_secret() {
  local worker="$1" config="$2" name="$3" secrets
  secrets="$(cf GET "$acct/workers/scripts/$worker/secrets")" \
    || die "could not list $worker's secrets; refusing to replace $name"
  if jq -e --arg n "$name" '.result[] | select(.name == $n)' <<<"$secrets" >/dev/null; then
    echo "secret: $name present" >&2
  else
    openssl rand -hex 32 | (cd "$api_dir" && "$wrangler" secret put "$name" -c "$config") >/dev/null
    echo "secret: $name created" >&2
  fi
}

# put_secret_if_set CONFIG NAME: copies $NAME from the environment into the Worker when set.
put_secret_if_set() {
  local config="$1" name="$2"
  if [ -n "${!name:-}" ]; then
    printf '%s' "${!name}" | (cd "$api_dir" && "$wrangler" secret put "$name" -c "$config") >/dev/null
    echo "secret: $name updated" >&2
  fi
}
