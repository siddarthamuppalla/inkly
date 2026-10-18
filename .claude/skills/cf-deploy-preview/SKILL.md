---
name: cf-deploy-preview
description: Deploy, list, or tear down a per-PR Cloudflare preview environment (inkly-pr-N Worker, D1, R2, KV, Job queue, pdf-engine Container). Use to get a URL for verify-app or verify-tenancy against real Cloudflare, or to clean up previews.
---

# cf-deploy-preview

Per-PR preview environments (Q9). Each PR gets its own isolated `inkly-pr-<n>`:
a Worker, a D1 database, an R2 bucket, a KV namespace, a Job queue
(`inkly-pr-<n>-jobs`) and a pdf-engine Container application (`inkly-pr-<n>-pdfengine`,
created by `wrangler deploy`, which builds the image and so needs Docker). Its
`EnvelopeLifecycle` Workflow is renamed `inkly-pr-<n>-envelope-lifecycle`, because Workflow
names are per account. Test hooks are on, with a fresh `TEST_HOOKS_SECRET` on every deploy;
`preview.yml` also sets a fresh Document seal key pair (`SEAL_PRIVATE_KEY`, `SEAL_CERTIFICATE`). Production is never touched; deploying
production is human-only.

## Setup (human, once)
Run `scripts/setup-cloudflare-secrets.sh`. It explains which token to create,
verifies it with Cloudflare without echoing it, and sets the GitHub secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Automation
- `.github/workflows/preview.yml` runs on PR open, sync and reopen. It deploys, checks
  there is exactly one of each resource, runs `verify-app J-000 J-007` and `verify-tenancy`
  against the URL, and comments the URL on the PR. It is skipped (green) while the
  secrets are not set.
- `.github/workflows/preview-teardown.yml` runs on PR close. It deletes all six
  resources, plus the Workflow, and fails if any of the six remain.
- `.github/workflows/preview-sweep.yml` runs nightly and on demand. It tears down
  every `inkly-pr-*` whose PR is no longer open.

## Usage
Needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `curl`, `jq`, and `pnpm i`.
```
.claude/skills/cf-deploy-preview/run.sh <pr>              # create or reuse, migrate, deploy, print url
.claude/skills/cf-deploy-preview/run.sh --list <pr>       # resources that exist for <pr>
.claude/skills/cf-deploy-preview/run.sh --teardown <pr>   # delete all six
.claude/skills/cf-deploy-preview/run.sh --sweep           # needs gh with GH_TOKEN
.claude/skills/cf-deploy-preview/run.sh --verify-token
```
Deploy is idempotent: resources are looked up by name and reused. It prints
`url: https://inkly-pr-<n>.<subdomain>.workers.dev` once `/health` returns 200. Set
`PREVIEW_SECRET_FILE=<path>` to receive the test-hooks secret, which is never printed.
Then run
`TEST_HOOKS_SECRET=$(cat <path>) .claude/skills/verify-app/run.sh --url <url> J-000`.

The preview config is generated from `workers/api/wrangler.jsonc` by
`preview-config.mjs` into `workers/api/wrangler.preview.json` (gitignored).
