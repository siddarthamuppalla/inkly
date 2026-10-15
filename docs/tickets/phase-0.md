# Phase 0 tickets (T0.2–T0.10)

Produced by T0.1 grilling. Decisions: `docs/decisions/T0.1-grilling-log.md`,
ADRs 0001–0004. Target: Phase 0 in ~1 day (Q1), so each ticket is one small
vertical slice. Every ticket is filed as a GitHub issue (Q10) **only after gate
approval**; branch `t/<issue#>-<slug>`.

Dependency order:
```
T0.2 ─┬─ T0.3
      ├─ T0.4
      └─ T0.5 ─┬─ T0.6
               ├─ T0.7 ─┐
               └─ T0.8 ─┴─ T0.9 ── T0.10
```

Conventions used in every ticket's verification:
`pnpm check` = `tsc -b` + `eslint .` + `prettier --check .` (ADR-0001).
"exits 0" / "exits non-zero" refers to the process exit code.

---

## T0.2 — Scaffold the monorepo

**Context:** ADR-0001. Nothing in the repo builds yet, so CI `check` fails at
`pnpm/action-setup` ("No pnpm version is specified").

**Acceptance criteria (predicates):**
- [ ] GIVEN a fresh clone WHEN `pnpm i --frozen-lockfile` runs THEN it exits 0 and `pnpm-lock.yaml` is unchanged.
- [ ] GIVEN root `package.json` THEN `packageManager` is `pnpm@<exact>` and `engines.node` is `22.x`, and `.nvmrc` contains `22`.
- [ ] GIVEN every `package.json` in the repo THEN no dependency version contains `^` or `~`.
- [ ] GIVEN the workspace THEN packages exist at `apps/web`, `workers/api`, `workers/jobs`, `packages/{domain,storage,pdf,auth,testing}`, each with a `tsconfig.json` extending `tsconfig.base.json`.
- [ ] GIVEN `tsconfig.base.json` THEN `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` are all `true`.
- [ ] GIVEN a clean tree WHEN `pnpm check` runs THEN it exits 0.
- [ ] GIVEN fixture file `tools/lint-fixtures/web-imports-storage.ts` (in `apps/web`, importing `packages/storage`) WHEN `pnpm lint:fixtures` runs THEN eslint reports `boundaries/dependencies` (the v7 name of the former `element-types` rule) for that file and the script exits 0 only because the violation is expected (fixture asserts the rule fires).
- [ ] GIVEN fixture `tools/lint-fixtures/d1-outside-storage.ts` (uses `D1Database` outside `packages/storage`) WHEN `pnpm lint:fixtures` runs THEN the local rule `inkly/no-direct-bindings` fires.
- [ ] GIVEN a file with a Prettier violation WHEN `pnpm check` runs THEN it exits non-zero.

**Verification:**
```
pnpm i --frozen-lockfile && git diff --exit-code pnpm-lock.yaml
pnpm check                          # exits 0
pnpm lint:fixtures                  # exits 0; output lists both expected violations
rg -n '"[\^~]' --glob '**/package.json'   # no matches
```
**Out of scope:** any runtime code beyond empty package entry points; Worker bindings (T0.5).
**Dependencies:** T0.1 approved.
**Risk:** medium (sets boundary rules every later ticket relies on).

---

## T0.3 — Reconcile the repo seed (CLAUDE.md, PR template, CI)

**Context:** The seed files are already on `main` at the repo root (not in
`repo-seed/` as `03_FACTORY_WORKFLOW` says). They predate T0.1 decisions.

**Acceptance criteria (predicates):**
- [ ] GIVEN `CLAUDE.md` THEN it links ADRs 0001–0004, `GLOSSARY.md`, and states the Q11 rule "no `/__test/*` outside dev/preview".
- [ ] GIVEN `.github/workflows/ci.yml` WHEN a PR is opened THEN jobs `check` and `secrets` both run and conclude `success` on this ticket's PR.
- [ ] GIVEN `ci.yml` THEN the workflow declares top-level `permissions: contents: read` and no job requests write scopes.
- [ ] GIVEN `docs/factory/03_FACTORY_WORKFLOW.md` THEN no reference to `repo-seed/` remains (`rg repo-seed docs/factory` returns nothing).
- [ ] GIVEN CI steps that reference not-yet-built skills (`verify-pdf`, `verify-tenancy`, e2e) THEN each runs only when its script exists, guarded so a missing script is reported as `skipped` in the job summary, not silently passed; T0.10 removes the guards.

**Verification:**
```
rg -n 'repo-seed' docs/factory  # no output
gh pr checks <pr>              # check ✓, secrets ✓  (or GitHub MCP: pull_request_read get_check_runs)
```
**Out of scope:** making CI gates *required* (T0.10).
**Dependencies:** T0.2.
**Risk:** low.

---

## T0.4 — Finish skill-pack setup

**Context:** `mattpocock-skills` and `pstack` are already enabled in
`.claude/settings.json` (T0.1 PR). Remaining: the per-repo config those skills read,
and the GitHub labels (Q10).

**Acceptance criteria (predicates):**
- [ ] GIVEN a fresh cloud session in this repo WHEN `claude plugin list` runs THEN both plugins show `enabled` at project scope.
- [ ] GIVEN `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md` THEN they exist and name GitHub Issues, the Q10 label set, and `GLOSSARY.md` + `docs/adr/` respectively.
- [ ] GIVEN `CLAUDE.md` THEN it has an `## Agent skills` section pointing at `docs/agents/`.
- [ ] GIVEN the GitHub repo THEN labels exist exactly: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`, `risk:high`, `needs-human`, `factory-pause`, `phase:0`…`phase:4`.

**Verification:**
```
claude plugin list | rg -A3 'mattpocock-skills|pstack'
ls docs/agents/
gh label list --limit 100     # (or GitHub MCP get_label) all 13 present
```
**Out of scope:** writing a pstack model override sheet (defaults are fine; revisit if costs warrant).
**Dependencies:** T0.2.
**Risk:** low.

---

## T0.5 — Hello-world API Worker with D1 + R2 + KV

**Context:** ADR-0001, ADR-0004. Proves real bindings work under
`@cloudflare/vitest-pool-workers` and establishes the `packages/storage` paved road.

**Acceptance criteria (predicates):**
- [ ] GIVEN `workers/api/wrangler.jsonc` THEN it binds D1 `DB`, R2 `FILES`, KV `KV`, and has no `TEST_HOOKS` var in the top-level (production) env.
- [ ] GIVEN `pnpm dev` WHEN `GET /health` THEN response is `200` with JSON `{ "ok": true, "d1": true, "r2": true, "kv": true }`, each flag set by a real round-trip to that binding.
- [ ] GIVEN `packages/domain` THEN it exports branded `TenantId` that cannot be assigned from `string` (a `// @ts-expect-error` test proves it).
- [ ] GIVEN `packages/storage` THEN its only public functions take `TenantId` as the first argument, and R2 keys are built as `t/{tenantId}/d/{documentId}/v{n}` by one function with a unit test.
- [ ] GIVEN a Vitest test in `workers/api` using vitest-pool-workers WHEN it writes then reads a row and an object for tenant A THEN reads as tenant B return nothing.
- [ ] GIVEN D1 migrations in `workers/api/migrations/` WHEN applied locally THEN `tenants` exists with a `region` column defaulting to `'default'` (Q2).

**Verification:**
```
pnpm test --filter @inkly/api       # all pass, includes cross-tenant read test
pnpm dev & sleep 5; curl -s localhost:8787/health   # {"ok":true,"d1":true,"r2":true,"kv":true}
pnpm check
```
**Out of scope:** auth (Phase 1), real document schema beyond `tenants`.
**Dependencies:** T0.2.
**Risk:** high (storage keys, tenancy).

---

## T0.6 — Fixture PDF corpus + `verify-pdf`

**Context:** `04_VERIFICATION` §verify-pdf. Correctness gate for every PDF-producing feature.

**Acceptance criteria (predicates):**
- [ ] GIVEN `fixtures/pdfs/` THEN it contains `tiny`, `10p`, `50p`, `scanned`, `encrypted`, `forms`, `malformed`, `rotated`, `huge-image` PDFs, each ≤ 5 MB, with a `README.md` stating provenance/licence and expected page count.
- [ ] GIVEN `.claude/skills/verify-pdf/run.sh <file>` on a valid fixture THEN it exits 0 and prints `qpdf ok`, page count, page sizes, rotation.
- [ ] GIVEN `run.sh fixtures/pdfs/malformed.pdf` THEN it exits non-zero and names the qpdf error.
- [ ] GIVEN `--expect-pages N` that does not match THEN it exits non-zero.
- [ ] GIVEN `--golden <dir>` THEN it renders with `pdftoppm -r 72`, compares with pixelmatch, and fails when the diff exceeds `--threshold` (default 0.1%); a test proves both pass and fail paths.
- [ ] GIVEN `--corpus fixtures/pdfs` THEN it checks every fixture against its expectation in `fixtures/pdfs/expectations.json` and exits 0 only if all match (malformed is expected to fail and counts as a pass).
- [ ] GIVEN `.claude/skills/verify-pdf/SKILL.md` THEN it documents when to run it and every flag.

**Verification:**
```
.claude/skills/verify-pdf/run.sh --corpus fixtures/pdfs        # exits 0, table of 9 rows
.claude/skills/verify-pdf/run.sh fixtures/pdfs/malformed.pdf; echo $?   # non-zero
pnpm --filter @inkly/testing test      # pixelmatch pass/fail tests
```
**Out of scope:** veraPDF `--pdfa` (added with PDF/A export later).
**Dependencies:** T0.5 (shares `packages/testing`).
**Risk:** low.

---

## T0.7 — `verify-app` + feature map (J-000 health check)

**Context:** `04_VERIFICATION` §verify-app; Q11 test hooks.

**Acceptance criteria (predicates):**
- [ ] GIVEN `pnpm dev` with `TEST_HOOKS=enabled` WHEN `POST /__test/seed` is called with the correct `x-test-hooks-secret` THEN it returns a fresh tenant id and user id created via `packages/storage`.
- [ ] GIVEN the same call without or with a wrong secret THEN it returns `404` (not 401, to avoid advertising the route).
- [ ] GIVEN a Worker build without `TEST_HOOKS` THEN `POST /__test/seed` returns `404` (unit test).
- [ ] GIVEN `.claude/skills/verify-app/feature-map.md` THEN it has row `J-000 | Health check | open / → GET /health | 200, all bindings true; SPA shell renders; 0 console errors |`.
- [ ] GIVEN `.claude/skills/verify-app/run.sh J-000` against `wrangler dev` THEN it exits 0 and writes `artifacts/verify-app/<run-id>/` with a Playwright trace, screenshot and `summary.md`.
- [ ] GIVEN a page that logs a console error or a request that returns 5xx THEN `run.sh` exits non-zero (proven by a fixture journey `J-FAIL` used only in the skill's self-test).
- [ ] GIVEN `run.sh --url <preview-url> J-000` THEN it targets that URL instead of starting `wrangler dev`.

**Verification:**
```
.claude/skills/verify-app/run.sh J-000                 # exits 0, prints artifact path
.claude/skills/verify-app/run.sh --self-test           # J-FAIL fails as expected → exits 0
pnpm --filter @inkly/api test test-hooks              # 404 without flag/secret
```
**Out of scope:** real user journeys (each feature PR adds rows).
**Dependencies:** T0.5.
**Risk:** medium (a test back door; gated by Q11 checks).

---

## T0.8 — `cf-deploy-preview` + per-PR preview environments

**Context:** Q9. Needs the human-only step: Cloudflare API token + account ID as
GitHub secrets. Ticket ships a guided script (`wizard` skill) for that step.

**Acceptance criteria (predicates):**
- [ ] GIVEN `scripts/setup-cloudflare-secrets.sh` THEN it walks a human through creating a token scoped to Workers Scripts, D1, R2, KV (edit) and setting `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`, and never echoes the token.
- [ ] GIVEN a PR is opened or synchronized THEN workflow `preview` creates (idempotently) `inkly-pr-<n>` Worker, D1, R2 bucket, KV namespace, applies migrations, sets a fresh `TEST_HOOKS_SECRET`, deploys, and comments the URL on the PR.
- [ ] GIVEN the workflow runs twice for the same PR THEN the second run reuses resources (no duplicates; verified by listing resources by name).
- [ ] GIVEN the preview URL WHEN `GET /health` THEN `200` with all bindings `true`, and its D1 database id differs from production's.
- [ ] GIVEN the PR is closed THEN workflow `preview-teardown` deletes all four `inkly-pr-<n>` resources; a nightly `preview-sweep` deletes any `inkly-pr-*` whose PR is closed.
- [ ] GIVEN `.claude/skills/cf-deploy-preview/run.sh <pr>` locally with the secrets in env THEN it performs the same deploy and prints the URL.

**Verification:**
```
# on this ticket's own PR:
curl -s https://inkly-pr-<n>.<account>.workers.dev/health   # all true
wrangler d1 list | rg inkly-pr-<n>                           # exactly one
# after closing a throwaway PR:
wrangler d1 list | rg inkly-pr-<m>                           # no output
```
**Out of scope:** production deploy (human-only).
**Dependencies:** T0.5; human sets secrets.
**Risk:** high (credentials, infra lifecycle).

---

## T0.9 — `verify-tenancy` skeleton

**Context:** ADR-0004. Runs against stub endpoints now; every later resource adds cases.

**Acceptance criteria (predicates):**
- [ ] GIVEN stub tenant-scoped endpoints `GET/PUT /v0/stub-docs/:id` and `GET /v0/stub-docs` backed by `packages/storage` THEN they exist only to give the skill something real to attack.
- [ ] GIVEN `.claude/skills/verify-tenancy/run.sh` WHEN it seeds tenants A and B (via test hooks) and, as A, attempts read, write, list on B's stub doc and a direct R2 key fetch THEN every attempt returns `403` or `404`, and the script exits 0.
- [ ] GIVEN each denied attempt THEN an access-log entry exists for it (stub logger in `packages/domain/log`), and the script asserts the count matches.
- [ ] GIVEN a deliberately broken build (env `VERIFY_TENANCY_SELFTEST=leak` makes the stub skip the tenant check) THEN `run.sh --self-test` sees a success and exits non-zero, proving the check can fail.
- [ ] GIVEN `--url <preview-url>` THEN it runs against a preview environment.

**Verification:**
```
.claude/skills/verify-tenancy/run.sh                    # exits 0, table of attempts all 403/404
.claude/skills/verify-tenancy/run.sh --self-test        # exits 0 because leak was detected
```
**Out of scope:** real documents, share links, envelopes (added by their features).
**Dependencies:** T0.7 (test hooks), T0.8 (for `--url`).
**Risk:** high (tenancy).

---

## T0.10 — Make CI gates required + metrics issue

**Context:** `04_VERIFICATION` §CI gates; `05_BOTS` Phase 0 exit; Q10 tracking issue.

**Acceptance criteria (predicates):**
- [ ] GIVEN `ci.yml` THEN it runs, unguarded: `pnpm check`, `pnpm test`, `verify-pdf --corpus`, `verify-tenancy`, `verify-app J-000` (smoke), gitleaks, `pnpm audit --audit-level high`, and a check that production `wrangler.jsonc` contains no `TEST_HOOKS`.
- [ ] GIVEN `main` branch protection THEN all jobs above are required status checks and force-push is disabled. (Human applies the setting; ticket ships the exact list and a `gh api` command.)
- [ ] GIVEN a PR that adds `TEST_HOOKS` to production config THEN CI fails (proven on a throwaway branch).
- [ ] GIVEN GitHub Issues THEN a pinned issue "Factory metrics & tracking" exists with the weekly metrics table from `03_FACTORY_WORKFLOW` and documents that adding label `factory-pause` stops bots.
- [ ] GIVEN the Phase 0 exit criterion THEN the issue tracks "all verify skills green in CI" with a start date.

**Verification:**
```
gh api repos/siddarthamuppalla/inkly/branches/main/protection | jq '.required_status_checks.contexts'
# throwaway branch with TEST_HOOKS in prod config → CI ❌ (link in PR)
```
**Out of scope:** enabling bots (Phase 1).
**Dependencies:** T0.3, T0.6, T0.7, T0.9.
**Risk:** medium (repo settings are human-applied).
