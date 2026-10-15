---
status: accepted
date: 2026-10-15
---

# 0001 — Monorepo & tooling: pnpm + Turborepo, ESLint-enforced boundaries

One repository with pnpm workspaces and Turborepo (local cache only), TypeScript
strict everywhere, ESLint flat config as the enforcement point for architecture
rules, Prettier for formatting, Vitest (with `@cloudflare/vitest-pool-workers`) and
Playwright for tests. We chose ESLint over Biome because the factory relies on the
fix-layer ladder: import boundaries and "no D1/R2 outside `packages/storage`" must
fail at lint time, which needs `eslint-plugin-boundaries`, type-aware rules and
custom rules that Biome cannot express.

## Decisions

- **Runtime/pm:** Node 22 LTS; pnpm pinned via `packageManager` in root `package.json`
  (`.nvmrc` matches). Exact versions only — no `^`/`~` ranges; lockfile committed,
  CI installs with `--frozen-lockfile`.
- **Turborepo:** pipelines `check`, `test`, `build`, `e2e`; local cache only (no
  hosted remote cache, so no paid service).
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`; one shared `tsconfig.base.json`.
- **Lint:** typescript-eslint `strict-type-checked`; `eslint-plugin-boundaries` encodes
  the CLAUDE.md boundaries (`apps/web` ↛ `workers/*`, `packages/storage`;
  `packages/domain` imports nothing with I/O); a local rule bans `D1Database`,
  `R2Bucket` and `env.DB`/`env.FILES` access outside `packages/storage`.
- **Format:** Prettier, checked in `pnpm check`.
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers` for unit/integration against
  real local bindings; Playwright for E2E and `verify-app`.
- **Root scripts:** `pnpm check` = `tsc -b` + `eslint` + `prettier --check`;
  `pnpm test`; `pnpm e2e`; `pnpm dev`.

## Consequences

- Each boundary rule must ship with a fixture that proves it fails (a deliberately
  bad import in a test fixture), so rules can't silently rot.
- ESLint type-aware linting is slower than Biome; acceptable at this repo size, and
  Turborepo caches per package.

## Considered options

- **Biome** — faster, one tool; rejected because it cannot express boundary and
  type-aware rules.
- **dependency-cruiser** for boundaries — capable, but a second config surface;
  `eslint-plugin-boundaries` keeps violations in the editor and the same `pnpm check`.
- **Nx** — heavier than needed for ~10 packages.
