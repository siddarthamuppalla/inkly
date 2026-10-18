# Auto-merge

Approved by Siddartha on 2026-10-16: green agent PRs merge on their own, behind
guardrails, with every feature verified in a real browser against real Cloudflare.
Production deploys still wait for a human on the `production` environment
(`docs/ops/deploy.md`).

## How it works
`.github/workflows/auto-merge.yml` runs when a `ci` or `preview` run finishes for a
PR, and when a PR is labelled, unlabelled or marked ready. It always runs main's copy
of itself and of `scripts/auto-merge.mjs`, so a PR cannot change the rules it is
judged by. The script merges (merge commit, `--match-head-commit`) only when all of
these hold:

| Guardrail | Rule |
|-----------|------|
| Who | Branch `t/*` or `claude/*` in this repo (no forks), authored by the repo owner, base `main`, not a draft. |
| Stop labels | None of `risk:high`, `needs-human`, `no-automerge`, `factory-pause`. |
| Kill switch | No open issue labelled `factory-pause`, `FACTORY_PAUSED` is not `true`, and `AUTO_MERGE` is not `off` (repo variables). |
| Evidence | The PR body has a Verification Evidence section. |
| Size | At most 2000 changed lines, and the full file list was readable. |
| Protected paths | No change to `.github/`, `scripts/`, `CLAUDE.md`, `docs/ops/`, `.claude/` (except `verify-app/feature-map.md`), the verify harness in `packages/testing/` (journey files excepted), `packages/auth/`, `packages/storage/`, D1 migrations, `wrangler.json(c)`, `package.json`, the lockfile, `pnpm-workspace.yaml` or `.nvmrc`. |
| Journeys | No journey ID removed from `feature-map.md`. |
| Checks | `check`, `test`, `verify-pdf`, `verify-perf`, `verify-app`, `verify-tenancy`, `verify-signing`, `audit`, `prod-config`, `secrets`, `workflows`, `verdict` and `preview` all ran and passed on the head commit (none skipped), and no other check failed. |
| Branch | Up to date with `main` and free of conflicts. |

The script posts one comment (marker `<!-- inkly-auto-merge -->`, edited in place)
that says what it is waiting for or which guardrail stopped it. A stopped PR needs a
change or a human merge; nothing else retries it.

## What "verified" means
- **`verify-app --all`** runs every journey in `.claude/skills/verify-app/feature-map.md`
  in Chromium, with an axe scan in light and dark at each checkpoint, and fails on any
  console error or 5xx. It then reads the API's own route table from `GET /__test/routes`
  and fails if any route got no 2xx or 3xx request from a journey. A new endpoint without
  a journey cannot merge.
- `ci.yml` runs it against `wrangler dev`; `preview.yml` runs it, and `verify-tenancy`,
  against the PR's own Worker, D1, R2 and KV on Cloudflare.
- `verify-perf --url` on the preview is reported but does not gate yet: split is over
  the 3 s bound on real Cloudflare on `main` today (#54). The `verify-perf` CI job does gate.

## Merges and push workflows
A merge made with the workflow token starts no `push` workflows. After merging, the
script starts `ci.yml` and `deploy.yml` on `main` with `workflow_dispatch`. The deploy
then waits for a human approval as before.

## Turn it off
- One PR: add the `no-automerge` label.
- Everything: set the repo variable `AUTO_MERGE` to `off`, or add `factory-pause` to the
  tracking issue (#20), which also stops the bots.

## One-time setup (human)
1. Apply the required checks in `docs/ops/branch-protection.md` (adds `workflows` and `preview`).
2. Settings, Actions, General, Workflow permissions: leave "Read and write permissions"
   available to workflows that ask for it (`auto-merge.yml` asks for `contents: write`).
