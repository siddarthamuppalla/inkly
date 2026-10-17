# Phase 2 tickets: forms, annotations, sharing

Roadmap: form fill · annotations + comments (DocSession DO) · secure share links ·
access logs · Triage + PR Watcher bots.

Grilling was kept short at Siddartha's request (fast path to a deployed app). Already
decided: Free share links expire within 7 days and have no password; Pro links can have
any expiry (or none), a password and download controls. Defaults taken without a gate:
- Filling a form and saving creates a new Version (like page ops); "Flatten" is an option
  on save. Form fills do not count against the page-op Limit.
- Annotations and comments live in a per-Document **DocSession** Durable Object (SQLite
  storage, single writer), named `{tenantId}/{documentId}`. The API authorizes the caller
  against the Document before it forwards anything to the DO. Clients get live updates and
  presence over a hibernating WebSocket. Viewers can read annotations but not write them
  (same rule as the rest of the API).
- Annotations are an overlay; they never change a Version. "Download with annotations"
  renders them into the bytes on the fly and does not store a Version.
- A Share link opens the Document's current Version at the time of each open. Only the
  sha256 of its token is stored, so the full URL is shown once, at creation.
- Share-link visitors never see annotations or comments.
- "No download" (Pro) serves the PDF inline and hides the download button; it deters, it
  does not prevent copying, and the UI says so.
- Every share-link open, unlock attempt and download writes an access-log entry with the
  link as the actor.

Dependency order:
```
T2.1 forms ─────────────┐
T2.2 annotations ───────┼─ T2.6 phase gate
T2.3 share links ─ T2.4 ┘
T2.5 bots (independent)
```
Migration numbers are reserved per ticket: T2.3 `0008_share_links.sql`,
T2.4 `0009_activity.sql`. T2.1 and T2.2 need no D1 migration.
Feature-map journeys are reserved too: J-009 forms, J-010 annotations, J-011 share
links, J-012 activity.

---

## T2.1 (#40): Fill PDF forms

**Context:** `01_GOAL` capability 4. pdf-lib reads and fills AcroForms in the Worker.
**Acceptance criteria (predicates):**
- [ ] `packages/pdf` gets `readFormFields(bytes)` returning each field's name, type (text, checkbox, radio, dropdown, option list), current value, options and page + rect, and `fillForm(bytes, values, { flatten })` returning bytes that pass `verify-pdf`; tested on `fixtures/pdfs/forms.pdf`. An unknown field name or a value outside a field's options throws `AppError("invalid_input")`.
- [ ] GIVEN a Document whose current Version has a form WHEN `GET /api/documents/:id/form` THEN it returns the fields; a Document without a form returns `{ fields: [] }`.
- [ ] GIVEN an editor WHEN they `POST /api/documents/:id/form` with values THEN a new Version exists whose `readFormFields` returns those values; with `flatten: true` the new Version has no form fields and the values are drawn on the page.
- [ ] GIVEN the viewer on a Document with a form THEN a "Fill form" panel lists the fields with matching inputs, "Save" creates the new Version and the viewer shows it; a Document without a form shows no panel.
- [ ] GIVEN a viewer Member THEN `POST …/form` returns 403 and is logged; across Tenants it returns 404 (add to `verify-tenancy`).

**Verification:** `pnpm test`; `verify-pdf` on the saved bytes; `verify-app J-009`; `verify-tenancy`; `pnpm check`.
**Out of scope:** building forms (adding fields), pre-fill from data, XFA forms.
**Risk:** medium.

## T2.2 (#41): Annotate and comment on a Document

**Context:** Architecture brief (DocSession DO). Annotations are an overlay on a Version.
**Acceptance criteria (predicates):**
- [ ] A `DocSession` Durable Object (SQLite-backed, declared in wrangler config with a migration tag) is the only writer of a Document's Annotations and Comments. Its name is `{tenantId}/{documentId}`, and only the API Worker reaches it, after `requireTenant` and a Document lookup.
- [ ] GIVEN an editor WHEN they add a highlight (page + rects + color), a note (page + point + text) or an ink stroke THEN `GET /api/documents/:id/annotations` returns it with author, Version number and time; they can edit and delete their own; owners/admins can delete any.
- [ ] GIVEN an Annotation WHEN Members add Comments THEN the thread lists them in order with author and time, and the thread can be resolved and reopened.
- [ ] GIVEN two browsers on the same Document WHEN one adds, edits or deletes an Annotation or Comment THEN the other shows the change within 2 s without reloading, and each sees the other's presence.
- [ ] GIVEN "Download with annotations" THEN the response passes `verify-pdf`, has the same page count, and contains the highlights, notes and ink as PDF annotations; no Version is created.
- [ ] GIVEN a viewer Member THEN reads succeed and writes return 403 (logged); a Member of another Tenant gets 404 on read, write and WebSocket upgrade (add to `verify-tenancy`).

**Verification:** `pnpm test` (DO via `vitest-pool-workers`); `verify-app J-010` incl. a two-context live update; `verify-tenancy`; `verify-pdf`; `pnpm check`.
**Out of scope:** @mentions and comment notifications, annotations on share links, text-selection snapping beyond the PDF.js text layer.
**Risk:** medium (new DO; tenancy at the DO boundary).

## T2.3 (#42): Share a Document with a secure link

**Context:** Q8 limits; `share_links` in the architecture brief. Bytes are served only by the API.
**Acceptance criteria (predicates):**
- [ ] Migration `0008_share_links.sql` adds `share_links(id, tenant_id, document_id, token_hash, created_by, created_at, expires_at, password_hash, allow_download, revoked_at)` and adds `share_link_id`, `ip`, `user_agent` columns to `access_log`. Only `packages/storage` touches it, and only `packages/auth` turns a token into a `TenantId`.
- [ ] GIVEN an editor WHEN they create a link for a Document THEN the response has a URL `/s/{token}` with ≥ 128 bits of randomness, D1 holds only the token's sha256, and the link is listed for the Document and on `/links`.
- [ ] GIVEN a Free Tenant THEN a link must expire within 7 days and a password or `allowDownload: false` is refused with 402 `limit_exceeded`; GIVEN Pro THEN any expiry or none, an optional password (hashed, never stored plain) and download on/off are accepted.
- [ ] GIVEN a signed-out visitor WHEN they open `/s/{token}` THEN the Document renders with PDF.js, Download works when allowed and is absent when not, and `GET /api/share/{token}/content` with download off returns `content-disposition: inline`.
- [ ] GIVEN a password link THEN content returns 401 until the password is entered; a wrong password is refused; more than 10 attempts in 10 minutes per link return 429 (KV).
- [ ] GIVEN an expired or revoked link, a Trashed Document or an unknown token THEN the API returns 404 and the page says the link is no longer available, with no detail about why.
- [ ] GIVEN any open, unlock attempt or download through a link THEN an access-log entry names the link, IP and user agent in the owning Tenant's log.
- [ ] GIVEN `/links` THEN the Tenant's links list with Document, created, expiry, opens and last open; Revoke takes effect on the next request. Viewers cannot create or revoke (403).
- [ ] `verify-tenancy`: a Member of Tenant A cannot list, create on, or revoke Tenant B's links (404), and a link token never opens any other Document.

**Verification:** `pnpm test`; `verify-app J-011`; `verify-tenancy`; `pnpm check`.
**Out of scope:** email-to-recipient sharing, per-recipient links, watermarking shared views.
**Risk:** high (unauthenticated access path, tenancy).

## T2.4 (#43): Show a Document's activity

**Dependencies:** T2.3.
**Acceptance criteria (predicates):**
- [ ] Migration `0009_activity.sql` adds `document_id` to `access_log` (backfilled from `resource` where it names a Document) with an index on `(tenant_id, document_id, id)`; every access-log write that concerns a Document sets it.
- [ ] GIVEN a Document THEN `GET /api/documents/:id/activity` returns its entries newest first, paginated, each with actor (Member name, or the Share link), action (viewed, downloaded, unlocked, denied, edited), IP/user agent when known and time.
- [ ] GIVEN the viewer THEN an "Activity" panel shows those entries; GIVEN `/links` THEN each link shows its own opens.
- [ ] Owners, admins and editors see activity; viewers get 403. Another Tenant gets 404 (add to `verify-tenancy`).

**Verification:** `pnpm test`; `verify-app J-012`; `verify-tenancy`; `pnpm check`.
**Out of scope:** tenant-wide audit export, retention settings.
**Risk:** medium.

## T2.5 (#44): Triage and PR Watcher bots

**Context:** `05_BOTS.md` (phase 2 enables Triage + PR Watcher). Same shape as the Verifier (`.github/workflows/verifier.yml`).
**Acceptance criteria (predicates):**
- [ ] `.github/workflows/triage.yml` runs a fresh Claude Code agent on `issues: opened` that dedupes against open issues, applies the triage labels from `docs/agents/triage-labels.md`, and either labels `ready-for-agent` with a repro and spec link or comments why not (`needs-info`/`needs-human`). Permissions: issues write, contents read.
- [ ] `.github/workflows/pr-watcher.yml` runs on a failed CI `workflow_run` or a PR review comment on a PR from a `t/*` or `claude/*` branch, and pushes a fix or replies; it never merges, never force-pushes, never touches `main`, and skips PRs labeled `risk:high` for code changes (comment only).
- [ ] Both exit before work when `factory-pause` is on the tracking issue or `FACTORY_PAUSED=true`, and skip with a summary line when `CLAUDE_CODE_OAUTH_TOKEN` is unset.
- [ ] A dry-run test proves each workflow's guard step (pause, missing token, branch filter) with `act`-free shell tests run in CI.

**Verification:** shell tests in CI; `actionlint` clean; `pnpm check`.
**Risk:** low.

## T2.6: Phase 2 gate

- [ ] T2.1–T2.5 merged; `verify-app` J-000…J-012 green on a preview and on production after the deploy approval; `verify-tenancy` green; feature map and `GLOSSARY.md` updated.
- [ ] Hand-off note for Phase 3 posted.
