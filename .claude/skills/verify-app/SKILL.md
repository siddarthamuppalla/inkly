---
name: verify-app
description: Drive the user journeys in feature-map.md in a real browser against local wrangler dev or a preview URL, failing on any console error or 5xx. Use before marking any user-facing change done, and in CI.
---

# verify-app

Runs the journeys listed in `feature-map.md` with Playwright (Chromium) and writes
evidence to `artifacts/verify-app/<run-id>/`: a Playwright trace and screenshots per
journey, and `summary.md`. Paste the summary path into the PR's Verification Evidence.

## When to run it
- Before marking any change to `apps/web` or an API route done: run the journeys it touches.
- When adding a feature: add its row to `feature-map.md` and its automation to
  `packages/testing/src/app/journeys.ts` under the same ID, then run it.
- After changing this skill: run `--self-test`.
- CI runs `--self-test`, `J-000`, `J-001`, `J-002`, `J-003`, `J-004`, `J-005`, `J-008` and `J-011` on every PR.
- Journeys that need a signed-in user call `signedIn(ctx)` from `src/app/sign-in.ts`: it seeds a
  Tenant and owner through `/__test/seed` and sends `Authorization: Bearer <token>` on
  every later request from the page. It needs the test-hooks secret.

## Usage
```
.claude/skills/verify-app/run.sh J-000 [J-001 ...]                  # local wrangler dev
.claude/skills/verify-app/run.sh --url https://<preview> [--secret S] J-000
.claude/skills/verify-app/run.sh --self-test
```

| Flag | Meaning |
|------|---------|
| `J-…` | Journey IDs to run. Each must be a row in `feature-map.md` and have automation, or the run exits 2. |
| `--url URL` | Target this URL instead of starting `wrangler dev`. |
| `--secret S` | Test-hooks secret for the target, used to seed. Defaults to `$TEST_HOOKS_SECRET`. Without it, seeding is skipped and noted in the summary. |
| `--out DIR` | Artifact root. Default `artifacts/verify-app/`. |
| `--self-test` | Runs the fixture journey `J-FAIL` against a built-in page four times: clean (must pass), console error, 5xx and an accessibility violation (each must fail for that reason). Exits 0 only if all four behave. |
| `-h`, `--help` | Print usage. |

Without `--url`, it builds `apps/web`, applies D1 migrations to a throwaway state
directory, and starts `wrangler dev` with `TEST_HOOKS=enabled` and a random secret.
It stops the server when done.

Every run:
1. checks that `POST /__test/seed` without the secret returns 404;
2. seeds a fresh tenant and user through `/__test/seed` when it has the secret;
3. runs each journey in a fresh browser context.

Each `checkpoint(name)` in a journey screenshots the page in the light and dark color
schemes and runs axe-core against WCAG 2.0/2.1/2.2 A and AA rules in each. A journey fails on
a failed expectation, on any console error or uncaught page error, on any 5xx response,
and on any axe violation. Failed requests (for example aborted ones) are
recorded in the summary but do not fail the run.

Exit codes: `0` pass, `1` a journey or check failed, `2` bad arguments or an unknown ID.

## Requirements
Run `pnpm i` first. Chromium is installed with
`pnpm --filter @inkly/testing exec playwright install --with-deps chromium`.
Alternatively, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an existing Chromium binary.

## Test hooks under `pnpm dev`
Copy `workers/api/.dev.vars.example` to `workers/api/.dev.vars` (it is gitignored) to
turn on `/__test/*` for manual runs. Never set `TEST_HOOKS` in production config (Q11).
