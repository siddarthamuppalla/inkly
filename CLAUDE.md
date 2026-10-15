# CLAUDE.md

This repo is a **software factory** for Inkly, a Cloudflare-hosted PDF &
document SaaS. Read `docs/factory/` (copies of the kickoff pack) before non-trivial work.

## Rule zero
Not done until verified. Every PR includes a Verification Evidence block.
"Inconclusive" = fail. Bugs need a failing repro first.

## Workflow
Grill → Model → Spec → Ticket → Build (TDD) → Verify → Review → Merge → Retro.
Use `/poteto-mode <task>` to pick the playbook. Stop at 👤 gates.
Never build a ticket without predicate acceptance criteria.

## Commands
- Install: `pnpm i`
- Dev: `pnpm dev` (wrangler dev for api + web)
- Check: `pnpm check` (tsc, eslint, boundaries)
- Test: `pnpm test` (vitest + vitest-pool-workers)
- E2E: `pnpm e2e`
- Verify: `.claude/skills/verify-*/run.sh`
- Preview deploy: `.claude/skills/cf-deploy-preview/run.sh`

## Paved roads (do not create alternatives)
- R2/D1 access: only `packages/storage` (requires `TenantId`)
- Auth/permissions: only `packages/auth`
- PDF ops in Workers: `packages/pdf`; heavy ops: enqueue job → `containers/pdf-engine`
- Errors: typed `AppError` from `packages/domain`; logging via `packages/domain/log`

## Boundaries
- `apps/web` must not import `workers/*` or `packages/storage`.
- `packages/domain` has no I/O.
- Audit events are append-only and written only by the Envelope/Document DO.

## Fixing mistakes
Prefer: architecture → lint/types/CI → tests → this file/skills → human review.
When you add a rule here, ask whether a lint rule or type could enforce it instead.

## Never without a human
Merge to main, prod deploy, prod data changes, billing, customer messages, secrets, force-push.
