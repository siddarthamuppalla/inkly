# Phase 1 tickets: core documents

Roadmap: auth + workspaces · upload (multipart) / view / download · folders ·
versioning · page ops in Worker · compress via Container · `verify-perf` baseline ·
Verifier + Builder bots. Phase 1 also ships the first production deploy, behind a
human approval.

Grilling was kept short at Siddartha's request (fast path to a deployed app).
Defaults taken without a gate: uploads stream through the API into R2 (multipart
above 10 MB) with Plan size Limits; file bytes are always served by the API, never
by presigned URLs, so every access is authorized and logged; every page op and
every restore creates a new Version; sign-up creates a personal Tenant with the
User as owner.

Dependency order:
```
T1.1 auth ─────┬─ T1.2 documents ─┬─ T1.3b page-op API + UI ─ T1.5 verify-perf
T1.3a pdf ops ─┘                  └─ T1.4b compress API + UI
T1.4a pdf-engine ────────────────────┘
T1.6 production deploy (independent)    T1.7 verifier bot (independent)
```
Migration numbers are reserved per ticket so parallel branches don't collide:
T1.1 `0004_auth.sql`, T1.2 `0005_documents.sql`, T1.4 `0006_jobs.sql`.

API routes read the caller from `workers/api/src/tenant-context.ts`
(`requireTenant` sets `session` and `tenantId`; `denyAccess` refuses and logs).
Auth internals change behind that seam only.

---

## T1.1: Sign in with Better-Auth and own a workspace

**Context:** ADR-0003, ADR-0004, Q4, Q5. Replaces the Phase 0 bearer sessions.
**Acceptance criteria (predicates):**
- [ ] GIVEN a new email WHEN the user requests a sign-in code at `/sign-in` and enters the code from the Outbox THEN they land on `/` signed in, a Tenant named "<name>'s workspace" exists with them as `owner`, and `GET /api/me` returns their user, Active tenant and role.
- [ ] GIVEN the session cookie THEN it is `HttpOnly`, `Secure` (outside local http), `SameSite=Lax`, and the session row is in D1.
- [ ] GIVEN `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set THEN `/sign-in` offers "Continue with Google"; when unset the button is absent and no 5xx occurs.
- [ ] GIVEN a signed-in owner WHEN they invite an email THEN the invitee gets an Outbox email, accepting it makes them a Member of that Tenant, and a Free Tenant refuses a second Member with a typed `limit_exceeded` error.
- [ ] GIVEN a User in two Tenants WHEN they switch Active tenant THEN subsequent requests act on the new Tenant only; naming a Tenant they are not a Member of returns 403 and an access-log entry.
- [ ] GIVEN more than 5 code requests for one email in 10 minutes THEN the 6th returns 429 (KV rate limit).
- [ ] GIVEN `EMAIL_PROVIDER` THEN one `EmailSender` interface has `outbox` (dev/test/preview, readable via `/__test/outbox`), `resend` and `cloudflare` implementations; CI never sends real mail.
- [ ] GIVEN `/__test/seed` THEN it creates the Tenant, User and session through `packages/auth` and still returns a bearer token, so `verify-tenancy` keeps working.
- [ ] Only `packages/auth` mints `TenantId`; `pnpm lint:fixtures` proves a fixture minting one elsewhere fails.

**Verification:** `pnpm test`; `verify-app J-002 J-008`; `verify-tenancy` (incl. Tenant switch attack); `pnpm check`.
**Out of scope:** passwords, SSO, Member role editing beyond invite/remove.
**Risk:** high (auth, tenancy).

## T1.2: Upload, view, download and organize documents

**Context:** ADR-0004 key scheme; data model in `06_ARCHITECTURE_BRIEF`.
**Acceptance criteria (predicates):**
- [ ] GIVEN a signed-in editor WHEN they upload `fixtures/pdfs/10p.pdf` THEN a Document with Version 1 exists, its R2 object is at `t/{tid}/d/{did}/v1`, and `document_versions` records sha256, bytes and pages=10.
- [ ] GIVEN a file over 10 MB THEN the upload uses R2 multipart and the stored sha256 equals the source file's.
- [ ] GIVEN a Free Tenant WHEN a 26 MB file is uploaded THEN 413 `limit_exceeded`; storage Usage over 500 MB is also refused.
- [ ] GIVEN a non-PDF or `malformed.pdf` THEN the upload is refused with 422 and nothing is written to R2.
- [ ] GIVEN the Documents page THEN Documents list newest first with title, pages, size and updated time; opening one renders every page with PDF.js and shows thumbnails.
- [ ] GIVEN Download THEN the bytes equal the current Version exactly (sha256 match) and every content read writes an access-log entry.
- [ ] GIVEN folders THEN a user can create, rename, nest, and delete empty folders, and move Documents between them.
- [ ] GIVEN a Document with 3 Versions THEN version history lists them and Restore v1 creates v4 with v1's bytes.
- [ ] GIVEN Delete THEN the Document moves to Trash, is hidden from lists, and can be restored.
- [ ] GIVEN a viewer Member THEN upload, delete and move return 403.
- [ ] `verify-tenancy` attacks Documents, Versions, folders and content across Tenants; stub-docs are deleted.

**Verification:** `pnpm test`; `verify-app J-003 J-004 J-005`; `verify-tenancy`; `verify-pdf` on downloaded bytes.
**Out of scope:** tags, search, share links (Phase 2), retention purge job.
**Risk:** high (storage keys, tenancy).

## T1.3: Page ops in the Worker

**T1.3a (`packages/pdf`)** — pure pdf-lib functions, no I/O:
- [ ] `merge(a, b, …)`, `split(doc, ranges)`, `rotate(doc, pages, deg)`, `reorder(doc, order)`, `deletePages(doc, pages)` each return bytes that pass `verify-pdf` with the expected page count and rotation, tested on the fixture corpus.
- [ ] Encrypted input fails with a typed `AppError("pdf_encrypted")`; malformed with `pdf_malformed`.
- [ ] Coverage of `packages/pdf` ≥ 80%.

**T1.3b (API + UI):**
- [ ] GIVEN a Document WHEN the user rotates, reorders or deletes pages in the viewer THEN a new Version is created and the viewer shows it.
- [ ] GIVEN two Documents WHEN merged THEN a new Document exists with the summed page count; GIVEN split by ranges THEN one new Document per range.
- [ ] Page ops count against the Free Limit of 50/month; the 51st returns 402 `limit_exceeded`.
- [ ] Inputs above the in-Worker ceiling (25 MB or 200 pages) are refused with a message pointing at the Container path (not silently attempted).

**Verification:** `pnpm test`; `verify-pdf`; `verify-app J-006`.
**Risk:** medium.

## T1.4: Compress via the pdf-engine Container

**T1.4a (`containers/pdf-engine`)**: HTTP service with qpdf + Ghostscript; `POST /compress?level=…` returns smaller bytes for `huge-image.pdf` that pass `verify-pdf`; tested by running the service locally.
**T1.4b (wiring):**
- [ ] GIVEN Compress on a Document THEN a Job row is created with an idempotency key, a Queue message goes to `workers/jobs`, the Container compresses, and a new Version appears; the UI shows job status until done.
- [ ] A job failure leaves the Document unchanged and the Job `failed` with the error.
- [ ] Re-delivering the same Queue message does not create a second Version.

**Verification:** `pnpm test` (jobs consumer with a fake engine); engine tests; `verify-app J-007` on a preview.
**Risk:** medium. Needs Workers Paid (asked).

## T1.5: `verify-perf` baseline

- [ ] `.claude/skills/verify-perf/run.sh [--url]` runs merge, split, rotate, compress on `50p.pdf`, 10 runs each, prints p50/p95, and fails on p95 > 3 s or > 20% regression against `perf-baseline.json`.
- [ ] A CI job runs it locally; the baseline file is committed.
**Risk:** low.

## T1.6: Production deploy

- [ ] `.github/workflows/deploy.yml` deploys `main` to `inkly-api` with production D1/R2/KV, applies D1 migrations first, and runs only after approval on the GitHub `production` environment.
- [ ] Production config has no `TEST_HOOKS` (existing `prod-config` gate), and after deploy `GET /__test/seed` returns 404 and `verify-app J-000` passes against the prod URL.
- [ ] A rollback runbook exists in `docs/ops/deploy.md`.
**Risk:** high (production). First deploy needs Siddartha's approval.

## T1.7: Verifier bot

**Changed 2026-10-16 (Siddartha):** the Claude agent step depended on
`CLAUDE_CODE_OAUTH_TOKEN`, which failed every run, so CI no longer uses any Claude
credential. The `verdict` job in `ci.yml` now posts the one PASS/FAIL comment from the CI
jobs' results, and the adversarial diff review is done by a fresh reviewer agent in the
builder's session. The original predicates below are kept for the record.

- [ ] A workflow runs a fresh Claude Code agent on each PR push that re-runs the verify skills and posts one PASS/FAIL verdict comment, updated in place; it skips with a summary line when `CLAUDE_CODE_OAUTH_TOKEN` is unset; it has read-only contents permission plus PR comments.
- [ ] `factory-pause` on the tracking issue or `FACTORY_PAUSED=true` makes it exit before doing work.
**Risk:** low.
