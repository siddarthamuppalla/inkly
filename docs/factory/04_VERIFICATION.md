# Verification — Skills, Feature Map, Evidence

Verification skills are **critical infrastructure** and are built in Phase 0,
before product features. Each lives in `.claude/skills/<name>/` with:
`SKILL.md` (when/how to use), a **reproducible CLI script** (`run.sh` / `run.ts`),
and where relevant a `feature-map.md`.

## What verification does and doesn't prove
- Proves: the behaviour in the acceptance criteria works end-to-end, repeatably.
- Doesn't prove: code quality, architecture fit, or security beyond what it checks —
  that's what review, static checks and `verify-tenancy` are for.

## Skills

### `verify-app`
- Starts `wrangler dev` (local) or targets a preview URL.
- Seeds a fresh tenant + users via a test-only endpoint/fixture.
- Drives journeys from `feature-map.md` with Playwright; captures trace, screenshots,
  console errors, failed network requests.
- Fails on any console error or 5xx.
- Output: `artifacts/verify-app/<run-id>/` + summary table.

### `feature-map.md` (owned by verify-app)
One row per user journey; every feature PR adds or updates rows.
```
| ID | Journey | Steps | Expected | Spec |
| J-001 | Upload & view PDF | login → upload sample-10p.pdf → open | 10 pages render, thumbnails shown | #12 |
```

### `verify-pdf <file> [--golden <dir>]`
- `qpdf --check` → must report no errors.
- Page count, page sizes, rotation match expectation.
- Text extraction sanity (pdftotext) for expected strings.
- Form fields present/filled values (pdf-lib read-back).
- Visual regression: `pdftoppm -r 72` → pixelmatch vs golden (threshold configurable).
- `--pdfa`: veraPDF passes the requested profile.
- Fixture corpus in `fixtures/pdfs/` (tiny, 10p, 50p, scanned, encrypted, forms, malformed, rotated, huge-image).

### `verify-signing`
- Creates an envelope with 2 signers (sequential), places fields, sends.
- Simulates both signers (email/OTP via test inbox), signs, completes.
- Asserts: final PDF passes `verify-pdf`; signature validates in pyHanko;
  document hash in audit trail matches final bytes; audit events complete
  (created, sent, viewed, signed ×2, completed) with timestamps, IP, UA;
  certificate of completion generated and attached; modifying one byte fails validation.

### `verify-tenancy`
- Two tenants A and B. As A, attempt to read/write/list B's documents, versions,
  share links, envelopes, R2 keys (direct + presigned), search results, webhooks.
- Every attempt must return 403/404 and produce an access-log entry. Any success = fail.

### `verify-perf`
- Runs merge/split/rotate/compress/fill on 50-page fixture; p95 < 3 s.
- Records Worker CPU time per request; flags > 80% of limit.
- Compares against `perf-baseline.json`; regression > 20% = fail.

### `cf-deploy-preview`
- Deploys branch to a preview Worker environment with isolated D1/R2/KV,
  runs migrations, prints URL. Used by Verifier Bot.

## Evidence block (required in every PR)
```
## Verification Evidence
| Check | Command | Result |
|-------|---------|--------|
| Unit/integration | pnpm test | ✅ 214 passed |
| Types/lint | pnpm check | ✅ |
| verify-app | .claude/skills/verify-app/run.sh J-001 J-004 | ✅ trace: artifacts/... |
| verify-pdf | ... | ✅ qpdf ok, visual diff 0.02% |
| Bug repro (before → after) | pnpm test repro-123 | ❌ → ✅ |
Acceptance criteria: [x] AC1 [x] AC2 …
```
Rules: "inconclusive", "should work", or missing rows = fail.
Verifier re-runs these on a fresh checkout; it never trusts the builder's report.

## CI gates (all required on PR)
`pnpm check` (tsc + eslint + boundaries) · `pnpm test` · `verify-pdf` on fixture corpus ·
`verify-tenancy` · `verify-app` smoke journeys · Gitleaks · dependency audit.
