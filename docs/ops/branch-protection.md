# Branch protection for `main` (T0.10)

A human applies this; agents never change repository settings.

> **Plan note:** GitHub Free does not enforce branch protection or rulesets on
> private repositories. This repo was made public on 2026-10-15 so that the rules
> below are enforced. If it ever goes private again, protection becomes advisory
> until the account moves to GitHub Pro or a Team organization.

## Required status checks
All are jobs in `.github/workflows/ci.yml`:

| Check | What it gates |
|-------|---------------|
| `check` | `pnpm check` (tsc, eslint with boundaries, prettier) and `pnpm lint:fixtures` |
| `test` | `pnpm test` (vitest, Workers pool, and the pdf-engine service tests with qpdf + Ghostscript) |
| `verify-pdf` | `verify-pdf --corpus fixtures/pdfs` |
| `verify-perf` | `verify-perf` (p95 ≤ 3 s, ≤ 20% regression vs `perf-baseline.json`) and `--self-test`. **Not yet in the required list below: a human adds it** once it has run green on a runner. |
| `verify-app` | `verify-app --self-test` and `J-000` smoke |
| `verify-tenancy` | `verify-tenancy` and `--self-test` |
| `audit` | `pnpm audit --audit-level high` |
| `prod-config` | production `wrangler.jsonc` has no `TEST_HOOKS` (Q11) |
| `secrets` | gitleaks |
| `workflows` | `scripts/bot-guard.test.sh` (bot kill switch, token and branch-filter guards) and `actionlint` on `.github/workflows/` |

`preview` is deliberately not required: it skips when the Cloudflare secrets are
absent, and fork PRs never get it. `verifier` (T1.7) is not required either: it
skips on drafts and until `CLAUDE_CODE_OAUTH_TOKEN` is set, and it stops while any
open issue carries `factory-pause` or the repo variable `FACTORY_PAUSED` is `true`.
`triage` and `pr-watcher` (T2.5) are not required for the same reasons; they are
not status checks on a PR's own commits at all (they run on `issues` and on CI or
review events). All three gate through `scripts/bot-guard.sh`.

## Apply it
With the GitHub CLI signed in as a repo admin:

```sh
gh api -X PUT repos/siddarthamuppalla/inkly/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["check", "test", "verify-pdf", "verify-app", "verify-tenancy", "audit", "prod-config", "secrets", "workflows"]
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
status checks to pass" and add the nine required checks above. Turn on "Require a pull
request before merging" and leave "Allow force pushes" off.

## Check it
```sh
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.required_status_checks.contexts'
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.allow_force_pushes.enabled'   # false
```
