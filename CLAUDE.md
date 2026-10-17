# CLAUDE.md

This repo is a **software factory** for Inkly, a Cloudflare-hosted PDF &
document SaaS. Read `docs/factory/` (copies of the kickoff pack) before non-trivial work.

## Decisions & vocabulary
- ADRs: [0001 monorepo & tooling](docs/adr/0001-monorepo-and-tooling.md) ·
  [0002 frontend](docs/adr/0002-frontend-framework.md) ·
  [0003 auth](docs/adr/0003-auth-provider.md) ·
  [0004 tenant isolation](docs/adr/0004-tenant-isolation.md)
- Grilling log: `docs/decisions/T0.1-grilling-log.md` · Tickets: `docs/tickets/`
- Vocabulary: [`GLOSSARY.md`](GLOSSARY.md) — use its terms; add new ones.
- Design system: [`docs/design/README.md`](docs/design/README.md) — colors only from `apps/web/src/styles/tokens.css`.

## Rule zero
Not done until verified. Every PR includes a Verification Evidence block.
"Inconclusive" = fail. Bugs need a failing repro first.

## Agent skills

Cloud sessions install `mattpocock-skills` and `pstack` at project scope via the SessionStart hook `.claude/hooks/session-start.sh` (no-op locally and when already installed).

### Issue tracker

GitHub Issues in this repo; ticket template and branch naming in `docs/agents/issue-tracker.md`.

### Triage labels

Default five triage roles plus `risk:high`, `needs-human`, `factory-pause`, `phase:0`–`phase:4`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` (not `CONTEXT.md`) + `docs/adr/`. See `docs/agents/domain.md`.

## Workflow
Grill → Model → Spec → Ticket → Build (TDD) → Verify → Review → Merge → Retro.
Use `/poteto-mode <task>` to pick the playbook. Stop at 👤 gates.
Never build a ticket without predicate acceptance criteria.

## Commands
- Install: `pnpm i`
- Dev: `pnpm dev` (wrangler dev for api + web)
- Check: `pnpm check` (tsc, eslint incl. boundaries, prettier)
- Prove lint rules still fire: `pnpm lint:fixtures`
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
- No `/__test/*` routes outside dev/preview: they mount only when `TEST_HOOKS=enabled`,
  which production config must never contain.
- Enforced by lint: `boundaries/dependencies` and `inkly/no-direct-bindings`
  (no `D1Database`/`R2Bucket`/`KVNamespace` or `env.DB|FILES|KV` outside `packages/storage`).

## Fixing mistakes
Prefer: architecture → lint/types/CI → tests → this file/skills → human review.
When you add a rule here, ask whether a lint rule or type could enforce it instead.

## CI gates
Required checks on `main` are listed in `docs/ops/branch-protection.md`; a new
verify skill adds a CI job there and to that list.

## Never without a human
Merge to main, prod deploy, prod data changes, billing, customer messages, secrets, force-push.
