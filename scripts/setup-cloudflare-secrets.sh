#!/usr/bin/env bash
# Guided, human-only setup of the Cloudflare credentials used by preview environments (T0.8, Q9).
# Sets the GitHub Actions secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
# The token is read without echo, sent only to Cloudflare (to verify it) and to GitHub (as a secret),
# and never printed or written to disk.
set -euo pipefail

repo="${1:-siddarthamuppalla/inkly}"
api="https://api.cloudflare.com/client/v4"

cat <<'TEXT'
Inkly preview environments need a Cloudflare API token and your account ID.

1. Open https://dash.cloudflare.com/profile/api-tokens and choose "Create Token",
   then "Create Custom Token". Give it these Account permissions, all set to Edit:
     - Workers Scripts
     - D1
     - Workers R2 Storage
     - Workers KV Storage
   Limit "Account Resources" to your Inkly account. No Zone permissions are needed.
2. Copy the token once it is shown.
3. Find your Account ID on the right-hand side of any Workers & Pages page.

TEXT

read -rsp "Paste the API token (input hidden): " token
echo
[ -n "$token" ] || { echo "No token entered." >&2; exit 1; }
read -rp "Account ID: " account
[[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "That does not look like an account ID (32 hex characters)." >&2; exit 1; }

check() { curl -sS "$1" -H "Authorization: Bearer $token" | grep -q '"success":[[:space:]]*true'; }
if check "$api/accounts/$account/tokens/verify" || check "$api/user/tokens/verify"; then
  echo "✓ Cloudflare accepted the token."
else
  echo "✗ Cloudflare rejected the token (or the account ID). Nothing was saved." >&2
  exit 1
fi
if check "$api/accounts/$account/d1/database?per_page=1"; then
  echo "✓ The token can read D1 in this account."
else
  echo "✗ The token cannot list D1 databases in this account; check its permissions." >&2
  exit 1
fi
if ! curl -sS "$api/accounts/$account/workers/subdomain" -H "Authorization: Bearer $token" \
  | grep -q '"subdomain":[[:space:]]*"[^"]'; then
  echo "! No workers.dev subdomain yet: open Workers & Pages in the dashboard once to create it."
fi

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  printf '%s' "$token" | gh secret set CLOUDFLARE_API_TOKEN -R "$repo"
  printf '%s' "$account" | gh secret set CLOUDFLARE_ACCOUNT_ID -R "$repo"
  echo "✓ Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID on $repo."
else
  cat <<TEXT

The GitHub CLI is not signed in here, so set the two secrets by hand:
  https://github.com/$repo/settings/secrets/actions  →  "New repository secret"
    CLOUDFLARE_API_TOKEN   = the token you just pasted
    CLOUDFLARE_ACCOUNT_ID  = $account
TEXT
fi
unset token
echo "Next: push to any open PR (or re-run its 'preview' workflow) to deploy a preview."
