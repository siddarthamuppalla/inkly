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
- CI runs `--self-test` and `--all` on every PR, against `wrangler dev` and against the PR's
  Cloudflare preview. Auto-merge requires both (`docs/ops/auto-merge.md`).
- Journeys that need a signed-in user call `signedIn(ctx)` from `src/app/sign-in.ts`: it seeds a
  Tenant and owner through `/__test/seed` and sends `Authorization: Bearer <token>` on
  every later request from the page. It needs the test-hooks secret.

## Usage
```
.claude/skills/verify-app/run.sh J-000 [J-001 ...]                  # local wrangler dev
.claude/skills/verify-app/run.sh --url https://<preview> [--secret S] J-000
.claude/skills/verify-app/run.sh --all [--url URL] [--secret S]   # every journey + route coverage
.claude/skills/verify-app/run.sh --self-test
```

| Flag | Meaning |
|------|---------|
| `J-…` | Journey IDs to run. Each must be a row in `feature-map.md` and have automation, or the run exits 2. |
| `--url URL` | Target this URL instead of starting `wrangler dev`. |
| `--secret S` | Test-hooks secret for the target, used to seed. Defaults to `$TEST_HOOKS_SECRET`. Without it, seeding is skipped and noted in the summary. |
| `--out DIR` | Artifact root. Default `artifacts/verify-app/`. |
| `--all` | Run every journey in `feature-map.md`, then check route coverage: read the API's routes from `GET /__test/routes` and fail for each one no journey reached with a 2xx or 3xx from the browser (a WebSocket that received a frame counts as its route's 101 upgrade). Requests a journey makes with `page.request` do not count; use `page.evaluate(fetch…)` for a backend-only check. Exits 2 if a journey in `journeys.ts` has no feature-map row. Needs the test-hooks secret. |
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
J-009 also runs verify-pdf on the Versions it saves, so it needs qpdf and poppler-utils.

## Test hooks under `pnpm dev`
Copy `workers/api/.dev.vars.example` to `workers/api/.dev.vars` (it is gitignored) to
turn on `/__test/*` for manual runs. Never set `TEST_HOOKS` in production config (Q11).
