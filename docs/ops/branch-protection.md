# Branch protection for `main` (T0.10)

A human applies this; agents never change repository settings.

> **Plan note:** GitHub Free does not enforce branch protection or rulesets on
> private repositories. This repo was made public on 2026-10-15 so that the rules
> below are enforced. If it ever goes private again, protection becomes advisory
> until the account moves to GitHub Pro or a Team organization.

## Required status checks
All are jobs in `.github/workflows/ci.yml`, except `preview` (`preview.yml`):

| Check | What it gates |
|-------|---------------|
| `check` | `pnpm check` (tsc, eslint with boundaries, prettier) and `pnpm lint:fixtures` |
| `test` | `pnpm test` (vitest, Workers pool, and the pdf-engine service tests with qpdf + Ghostscript) |
| `verify-pdf` | `verify-pdf --corpus fixtures/pdfs` |
| `verify-perf` | `verify-perf` (p95 ≤ 3 s, ≤ 20% regression vs `perf-baseline.json`) and `--self-test`. **Not yet in the required list below: a human adds it** once it has run green on a runner. |
| `verify-app` | `verify-app --self-test` and `verify-app --all`: every journey in `feature-map.md`, and a failure for any API route no journey reached with a 2xx |
| `verify-tenancy` | `verify-tenancy` and `--self-test` |
| `audit` | `pnpm audit --audit-level high` |
| `prod-config` | production `wrangler.jsonc` has no `TEST_HOOKS` (Q11) |
| `secrets` | gitleaks |
| `workflows` | `node --test scripts/auto-merge.test.mjs` (auto-merge guardrails) and `actionlint` with shellcheck |
| `preview` | deploys `inkly-pr-<n>` to Cloudflare, then `verify-app --all` and `verify-tenancy` against it. Fails when the Cloudflare secrets are missing; fork PRs skip it. |

`verdict` (T1.7) is not required: it
only restates the jobs above as one PASS/FAIL comment on the PR, and it skips on
pushes to `main` and on fork PRs.

## Apply it
With the GitHub CLI signed in as a repo admin:

```sh
gh api -X PUT repos/siddarthamuppalla/inkly/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["check", "test", "verify-pdf", "verify-app", "verify-tenancy", "audit", "prod-config", "secrets", "workflows", "preview"]
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
status checks to pass" and add the ten checks above. Turn on "Require a pull
request before merging" and leave "Allow force pushes" off.

## Check it
```sh
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.required_status_checks.contexts'
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.allow_force_pushes.enabled'   # false
```
