# Glossary

Agents must use these terms. Seeded from `docs/factory/09_GLOSSARY.md`; this file is
the living copy. Add a term when you introduce it; list rejected synonyms under _Avoid_.

## Tenancy & identity

**Tenant**: A paying workspace/organization; the isolation boundary for all data.
_Avoid_: org, account, workspace (in code)

**User**: A person who can sign in; global across tenants.
_Avoid_: account

**Member**: A User's role (owner, admin, editor, viewer) within one Tenant, stored as a membership.

**Active tenant**: The single Tenant a request acts within, chosen from the session and checked against membership.

**TenantId**: Branded identifier for a Tenant, minted only by `packages/auth` after a membership check; required by every `packages/storage` call.

**Session**: A signed-in User's session row in D1, presented as an HTTP-only cookie or an `Authorization: Bearer` token; it records the Active tenant.

**Sign-in code**: A 6-digit, 10-minute code emailed to sign in or sign up (Better-Auth email OTP). At most 5 code or link requests per email per 10 minutes.
_Avoid_: password, OTP (in UI copy)

**Invitation**: An emailed offer for one address to become a Member of a Tenant with a role; accepting it takes a seat under the Plan's member Limit (Free 1, Pro 5).

**Region**: Where a Tenant's data is stored; only `default` exists until EU residency is built.

**Plan**: The billing tier of a Tenant (`free` or `pro`); it determines Limits.

**Limit**: A per-Plan cap (members, storage, file size, page ops, envelopes) enforced server-side.

**Usage**: A Tenant's metered consumption per billing period, checked against its Limits.
_Avoid_: quota, credits

## Documents

**Document**: A logical file owned by a tenant; has one or more versions.

**Version**: An immutable PDF byte stream in R2 with sha256; edits create new versions.

**Current version**: The Version a Document shows and downloads; the newest one, since restoring an old Version copies it into a new one.

**Restore (version)**: Copying an earlier Version's bytes into a new current Version; nothing is overwritten.
_Avoid_: revert, rollback

**Folder**: A named, nestable container for Documents within one Tenant; a Document is in at most one folder, or at the top level.
_Avoid_: directory

**Trash**: Where a deleted Document waits (`deleted_at` set); hidden from lists and restorable. Its bytes stay stored and count toward storage Usage.
_Avoid_: recycle bin, archive

**Access log**: Append-only record, per Tenant, of denied requests and of every read of Document content.

**Page op**: A structural change: merge, split, rotate, reorder, delete, insert.

**Annotation**: Non-destructive overlay (highlight, comment, drawing) until flattened.

**Flatten**: Burn annotations/form values into page content, producing a new version.

**Share link**: Tokenized, optionally expiring/password-protected access to a document.

## Signing

**Envelope**: A signing request: one document + recipients + fields + lifecycle.

**Recipient**: A party on an envelope: signer, approver, or CC.

**Field**: A placed input on a page (signature, initials, date, text, checkbox).

**Audit trail**: Append-only, hash-chained events for a subject (document/envelope).

**Certificate of completion**: PDF summary of an envelope's audit trail appended to the signed doc.

## Processing

**Job**: Async unit of work on a Queue, possibly executed in the pdf-engine Container.

**Job status**: Where a Job is: `queued`, `running`, `succeeded` or `failed` (with an error). A failed Job never changed its Document.

**Idempotency key**: The per-Tenant key a Job is enqueued under; enqueueing the same key again returns the existing Job. Compress defaults it to the Document, Version and level, or takes the client's `Idempotency-Key` header.

**Compress level**: pdf-engine's quality preset: `screen` (Smallest file), `ebook` (Balanced, the default) or `printer` (Best quality).

**pdf-engine**: Container service for heavy PDF ops.

**Worker ceiling**: The largest input a Page op runs on inside a Worker (25 MB or 200 pages, `MAX_WORKER_BYTES`/`MAX_WORKER_PAGES` in `packages/pdf`); larger inputs go to pdf-engine.

**Page number**: A 1-based page position (`PageNumber` in `packages/pdf`); the first page is 1.
_Avoid_: page index (for 1-based values)

## Factory

**Preview environment**: An isolated per-PR deployment (`inkly-pr-<n>`) with its own Worker, D1, R2 and KV; destroyed when the PR closes.
_Avoid_: staging

**Test hooks**: The `/__test/*` routes (seed tenant/users, read Outbox) that exist only in dev and Preview environments.

**Outbox**: Captured outgoing email in dev/test/preview instead of real delivery; read by verification skills.

**Email sender**: The one `EmailSender` interface in `packages/auth`; `EMAIL_PROVIDER` picks `outbox`, `resend` or `cloudflare` (Cloudflare Email Service).

**Paved road**: The single sanctioned way to do a concern in the codebase.

**Verification Evidence**: Required PR block proving acceptance criteria hold.

**Perf baseline**: `.claude/skills/verify-perf/perf-baseline.json`, the p95 per PDF op that `verify-perf` compares against; a p95 over 3 s always fails, and one more than 20% (and 50 ms) above its baseline fails as a regression.

**Feature map**: Catalogue of user journeys verified by `verify-app`.

**Gate (👤)**: A pipeline step requiring explicit human confirmation.

**Builder / Verifier**: Agent that writes the change / separate agent that judges it.

**Design token**: A named color or size in `apps/web/src/styles/tokens.css`; components use tokens, never raw colors.

**Seal**: The single red accent color, reserved for signing, required fields and danger.

**Checkpoint**: A point in a verify-app journey that screenshots the page in light and dark and runs an axe WCAG 2.1 AA scan of each.

**Fix-layer ladder**: Architecture → static → tests → skills → human review.
