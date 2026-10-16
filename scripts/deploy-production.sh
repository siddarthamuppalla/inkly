#!/usr/bin/env bash
# Deploys main to production (T1.6). Runs from .github/workflows/deploy.yml after a human
# approves the `production` environment; never run it from an agent session.
#
#   scripts/deploy-production.sh     create or reuse the `inkly` Worker, D1, R2, KV and the
#                                    `inkly-jobs` queue; wrangler builds the pdf-engine image
#                                    (needs Docker and Workers Paid),
#                                    migrate, deploy, smoke-test, print the URL
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Optional secrets copied into the
# Worker when set: RESEND_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, EMAIL_PROVIDER,
# EMAIL_FROM. With RESEND_API_KEY and no EMAIL_PROVIDER, sign-in mail goes through Resend
# from its shared test sender, which only delivers to the Resend account's own address.
set -euo pipefail

# shellcheck source=../.claude/skills/cf-deploy-preview/cf-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.claude/skills/cf-deploy-preview/cf-lib.sh"

name="inkly"
verify_token
ensure_resources "$name"
config="$(node "$here/preview-config.mjs" "$name" "$D1_ID" "$KV_ID" --production)"
node "$root/scripts/check-prod-config.mjs" "$config"

pnpm --dir "$root" --filter @inkly/web build >/dev/null
(cd "$api_dir" && "$wrangler" d1 migrations apply DB --remote -c "$config")
(cd "$api_dir" && "$wrangler" deploy -c "$config")

ensure_random_secret "$config" BETTER_AUTH_SECRET
if [ -n "${RESEND_API_KEY:-}" ]; then
  EMAIL_PROVIDER="${EMAIL_PROVIDER:-resend}"
  EMAIL_FROM="${EMAIL_FROM:-Inkly <onboarding@resend.dev>}"
fi
for s in RESEND_API_KEY GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET EMAIL_PROVIDER EMAIL_FROM; do
  put_secret_if_set "$config" "$s"
done

url="$(workers_dev_url "$name")"
wait_healthy "$url"
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/__test/seed")"
[ "$status" = "404" ] || die "POST $url/__test/seed returned $status, expected 404 (Q11)"
echo "test-hooks: 404"
echo "health: $(curl -s "$url/health")"
echo "url: $url"
