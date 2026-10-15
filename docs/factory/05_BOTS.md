# Bots — The Outer Loop

Bots do **intake, routing and verification**. Builder agents do engineering.
Each bot = one owner role + bounded brief + checkable done condition.

## Roster
| Bot | Runs on | Trigger | Job | Done when | Permissions |
|-----|---------|---------|-----|-----------|-------------|
| **Triage** | GitHub Action | issue opened, Sentry alert, support email | `triage`: dedupe, label, reproduce, link spec | labeled `ready-for-agent` with repro, or closed w/ reason | issues: write; code: read |
| **Chief of Staff** | scheduled task (daily) | 08:45 weekdays | rank backlog, assign tickets respecting deps/WIP limit, post daily plan | plan comment on tracking issue | issues: write |
| **Builder** | Claude Code cloud session / worktree | `ready-for-agent` label or assignment | `poteto-mode` playbook → PR with evidence | PR open, CI green, evidence complete | branch push, PR create; **no merge** |
| **Verifier** | GitHub Action (fresh agent) | PR opened/synchronized | fresh checkout → `cf-deploy-preview` → rerun verify-* → `interrogate` | verdict comment: PASS / FAIL + findings | read-only + comment |
| **PR Watcher** | GitHub Action / `watch-pr` | CI fail, review comment | fix CI, address comments, push | CI green, threads resolved | branch push |
| **Retro** | scheduled task (weekly) | Fri | `retro` over merged/rejected PRs + metrics | ≤ 5 environment-improvement PRs/issues | PR create |

## Hard rules
1. A builder never approves its own work; verifiers are separate and read-only.
2. A new commit invalidates the previous verdict.
3. Humans only: merge to `main`, production deploy, prod data migrations/deletes,
   billing/pricing, customer messages, secrets, force-push.
4. WIP limit: max [3] concurrent builder sessions until Phase 3.
5. Bots share no credentials beyond their table permissions; secrets live in GitHub/Cloudflare secrets.
6. Every autonomous run writes a decision log; `ASSUMPTION` rows require human review.
7. Bots stop and open a `needs-human` issue rather than guess on: ambiguous specs,
   security/compliance questions, schema changes to signing/audit tables.

## Rollout
| Phase | Enabled | Promote when |
|-------|---------|--------------|
| 0 | CI + verify-* skills; 1 supervised agent | all verify skills green in CI for 1 week |
| 1 | Verifier + Builder (review-ready PRs) | rework < [30]%, 0 escaped tenancy/signing defects |
| 2 | Triage + PR Watcher | triage accuracy > [90]% on sampled issues |
| 3 | Chief of Staff + parallel builders (`swarm`/`implement-spec`) | review time/PR falling, escaped defects flat or down |
| 4 | Auto-merge for low-risk labels only (`docs`, `deps-patch`, `copy`) | 4 weeks clean at Phase 3 |

High-risk areas (signing, audit, tenancy, billing, storage keys) **never** auto-merge.

## Kill switch
Label `factory-pause` on the tracking issue (or repo variable `FACTORY_PAUSED=true`)
stops all bots at their next checkpoint.
