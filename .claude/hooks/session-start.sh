#!/usr/bin/env bash
# Installs the project skill packs in fresh cloud sessions (T0.4, decision on PR #12).
# Idempotent: exits quickly when both plugins are already installed.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Marketplaces declared in .claude/settings.json are not cloned in a fresh HOME,
# so add them (user scope) before installing.
marketplaces=(
  "claude-plugins-official anthropics/claude-plugins-official"
  "pstack-claude michael-denyer/pstack-claude"
)
plugins=(
  "mattpocock-skills@claude-plugins-official"
  "pstack@pstack-claude"
)

installed="$(claude plugin list 2>/dev/null || true)"
missing=0
for p in "${plugins[@]}"; do
  grep -q "$p" <<<"$installed" || missing=1
done
[ "$missing" = 0 ] && exit 0

known="$(claude plugin marketplace list 2>/dev/null || true)"
for m in "${marketplaces[@]}"; do
  read -r name repo <<<"$m"
  if ! grep -q "$name" <<<"$known"; then
    claude plugin marketplace add "$repo" </dev/null >/dev/null 2>&1 \
      || echo "session-start: failed to add marketplace $name" >&2
  fi
done

for p in "${plugins[@]}"; do
  if ! grep -q "$p" <<<"$installed"; then
    claude plugin install "$p" --scope project </dev/null >/dev/null 2>&1 \
      || echo "session-start: failed to install $p" >&2
  fi
done
