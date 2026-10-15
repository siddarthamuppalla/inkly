# Branch protection for `main` (T0.10)

A human applies this; agents never change repository settings.

## Required status checks
All are jobs in `.github/workflows/ci.yml`:

| Check | What it gates |
|-------|---------------|
| `check` | `pnpm check` (tsc, eslint with boundaries, prettier) and `pnpm lint:fixtures` |
| `test` | `pnpm test` (vitest, Workers pool) |
| `verify-pdf` | `verify-pdf --corpus fixtures/pdfs` |
| `verify-app` | `verify-app --self-test` and `J-000` smoke |
| `verify-tenancy` | `verify-tenancy` and `--self-test` |
| `audit` | `pnpm audit --audit-level high` |
| `prod-config` | production `wrangler.jsonc` has no `TEST_HOOKS` (Q11) |
| `secrets` | gitleaks |

`preview` is deliberately not required: it skips when the Cloudflare secrets are
absent, and fork PRs never get it.

## Apply it
With the GitHub CLI signed in as a repo admin:

```sh
gh api -X PUT repos/siddarthamuppalla/inkly/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["check", "test", "verify-pdf", "verify-app", "verify-tenancy", "audit", "prod-config", "secrets"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false
}
JSON
```

Or use the web UI: Settings, Branches, then add a rule for `main`. Turn on "Require
status checks to pass" and add the eight checks above. Turn on "Require a pull
request before merging" and leave "Allow force pushes" off.

## Check it
```sh
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.required_status_checks.contexts'
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.allow_force_pushes.enabled'   # false
```
