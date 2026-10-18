# Phase 3 tickets: e-signature

Roadmap: Envelope DO + Workflows · field placement UI · signer flow (email/OTP) ·
hash-chained audit trail · completion certificate · `verify-signing`.

Grilling was kept short at Siddartha's request (fast path to a deployed app). The signing
model is [ADR-0006](../adr/0006-signing-model-and-audit-chain.md). Defaults taken without a
gate (all reversible before launch):
- Simple electronic signature only. Signers are not Users: they open an emailed link and
  confirm a 6-digit code sent to the same address before they can view or sign.
- Recipients are signers or CCs; approvers are out of scope. Order is parallel or
  sequential (by routing order).
- Fields: signature, initials, date (filled with the signing date), text, checkbox. Each
  belongs to one signer; every signer needs at least one signature field.
- An Envelope pins the Document's current Version when drafted; the sealed result becomes
  a new Version of that Document.
- Envelopes expire 30 days after sending unless the sender picks 1–90 days; pending
  signers get a reminder every 3 days.
- The output carries a self-signed Inkly document seal (PAdES B-B). Readers will say the
  signer's identity is "unknown" until a public-CA certificate replaces it.
- Sending counts against the Plan's monthly envelope Limit (Free 3, Pro 50).

👤 Needs Siddartha before the production deploy: the production seal key secrets
(`SEAL_PRIVATE_KEY`, `SEAL_CERTIFICATE`, set with `scripts/seal-key.sh`), and a sending
domain + `EMAIL_FROM` so signing emails reach people other than the Resend account owner.

Dependency order:
```
T3.1 envelope core ──┬─ T3.2 field placement UI ──┐
                     ├─ T3.3 signer flow ─────────┼─ T3.6 verify-signing ─ T3.7 gate
T3.4 sealed output ──┴─ T3.5 completion ──────────┘
```
Reserved: migration `0010_envelopes.sql` (T3.1); DO migration tag `v3-envelope` (T3.1);
Workflow `EnvelopeLifecycle` binding `ENVELOPE_LIFECYCLE` (T3.5); journeys J-016 send an
Envelope (T3.2), J-017 sign as two signers (T3.3 + T3.5), J-018 decline and void (T3.3).

## Shared contract

Builders work in parallel against this; changing it means changing this file in the same PR.

**Tables (0010):** `envelopes(tenant_id, id, document_id, version, title, message, status,
order_mode, expires_in_days, created_by, created_at, updated_at, sent_at, expires_at,
completed_at, final_version)`, `recipients(tenant_id, envelope_id, id, email, name, role,
routing_order, status, token_hash UNIQUE, notified_at, viewed_at, signed_at, declined_at,
decline_reason, code_hash, code_expires_at, code_attempts, verified_ip,
verified_user_agent)`, `fields(tenant_id, envelope_id, id, recipient_id, kind, page, x, y,
w, h, required, value)`, `audit_events(tenant_id, subject_type, subject_id, seq, actor,
action, detail, ip, user_agent, at, prev_hash, hash, PRIMARY KEY (tenant_id, subject_type,
subject_id, seq))` with triggers aborting `UPDATE`/`DELETE` on `audit_events`. Recipient and
Field primary keys are `(tenant_id, envelope_id, id)`. `expires_in_days` (1–90, default 30)
holds the draft's choice until send sets `expires_at`. Field geometry is page-relative
0..1, origin top-left, like Annotations. Ids: `env_`, `rcp_`, `fld_`. `audit_events.actor` is
a UserId (Member), a RecipientId (signer) or `system` (Workflow); `detail` is canonical JSON.

**Writes (T3.1):** only `workers/api/src/envelope/do.ts` imports `@inkly/storage/envelopes`
(`insertEnvelope`, `replaceDraft`, `deleteDraft`, `commitEnvelope` for any status, Recipient
or Field change plus its audit events in one batch, `claimEnvelope`/`releaseEnvelope`).
T3.3/T3.5 add DO methods that call `commitEnvelope`; reach the DO with
`envelopeObject(env, tenantId, envelopeRow)`. DO methods return
`{ ok: true, value } | { ok: false, code, message }` (an AppError code).

**PUT draft body:** `{ title, message?, orderMode?, expiresInDays?, recipients: [{ id?, name,
email, role, routingOrder? }], fields: [{ id?, recipientId, kind, page, rect: {x, y, w, h},
required? }] }`. A field names its Recipient by id, so a client that adds fields sends
Recipient ids (`rcp_…`, kept across saves); missing ids are minted. Responses are
`{ envelope, recipients, fields }`. Audit events carry every hashed field (`tenantId`,
`subjectType`, `subjectId`, …, `prevHash`, `hash`) so clients can rerun `verifyChain`.

**Remind:** only token hashes are stored, so a reminder mints a fresh link per pending
signer and the previous link stops working.

**Completion (T3.5):** T3.3 ends the last signature by calling the DO's public
`markAllSigned(ref, origin)` after its sign mutation (it takes its own
`blockConcurrencyWhile`; inside a mutation call the private `beginCompletion(ref, envelope,
origin)` instead). It refuses (409) unless every signer is `signed`, sets `completing` (no
audit event: the contract has no `completing` action) and sends the `all-signed` event to
the `EnvelopeLifecycle` instance, starting one if none exists. The Workflow then calls
`finalize(ref, origin)`, which commits `completed`, `completed_at`, `final_version` and a
`completed` event `{ version, sha256 }` with actor `system`. Workflow reminders are
`reminded` events with actor `system` and `detail.round`, so a retried round sends nothing
twice; `expired` carries `{ expiresAt }`. Void terminates the instance; on decline (T3.3)
or any other end state the loop stops at its next round, or T3.3 may terminate it the same
way. Completion mints a fresh link for every Recipient (signers too, since only hashes are
stored), so the invite link stops working and the completion email's link downloads the
signed PDF for 30 days: T3.3's `GET /api/sign/:token/content` returns
`signedPdf(tenantId, env, envelope)` from `workers/api/src/envelope/content.ts` (null before
completion or after the 30 days). While finalize writes its Version, the sealed sha256 sits
in the Envelope DO's own storage (key `sealing`) so a retry reuses a Version that landed.
`GET /api/seal-certificate` answers `application/x-pem-file`. Previews name the Workflow
`inkly-pr-<n>-envelope-lifecycle` (names are per account); production becomes
`inkly-envelope-lifecycle` the same way.

**Statuses:** Envelope `draft | sent | completing | completed | declined | voided |
expired`; Recipient `waiting | sent | viewed | signed | declined` (CCs stay `waiting`
until completion). Audit actions: `created, sent, notified, viewed, code_sent, verified,
signed, declined, voided, expired, reminded, completed`.

**Sender API** (behind `requireTenant`; viewers read-only, logged 403):
`POST /api/envelopes {documentId}` → draft · `GET /api/envelopes?status=` ·
`GET /api/envelopes/:id` (envelope, recipients, fields) · `PUT /api/envelopes/:id` (draft
only: title, message, orderMode, expiresInDays, recipients[], fields[]; replaces the
draft) · `DELETE /api/envelopes/:id` (draft only) · `POST /api/envelopes/:id/send` ·
`POST /api/envelopes/:id/void {reason}` · `POST /api/envelopes/:id/remind` ·
`GET /api/envelopes/:id/audit` (events + `{ chain: { valid, head } }`) ·
`GET /api/envelopes/:id/content` (the pinned Version, or the sealed PDF once completed).

**Signer API** (public, token-resolved in `packages/auth`, every request audited or
access-logged in the owning Tenant): `GET /api/sign/:token` · `POST /api/sign/:token/code` ·
`POST /api/sign/:token/verify {code}` · `GET /api/sign/:token/content` ·
`POST /api/sign/:token/sign {values, consent: true}` · `POST /api/sign/:token/decline {reason}`.
`GET /api/seal-certificate` is public.

**Signer API as built (T3.3):** `GET /:token` returns `SignerEnvelope` (packages/domain
`signing.ts`): `{ status: "pending", title, message, sender: {name, email}, recipient:
{name}, verified, pages, fields }`, where `fields` (this signer's only) and `pages` are
filled in only while the browser holds the grant; or the done state `{ status: "signed",
title, role, signedAvailable }` for a signer who signed or any Recipient's completion link
(`signedAvailable` while `signedPdf` would serve). `code` and `verify` answer 204; `sign`
and `decline` answer `{ status }`. The grant is the `inkly_sign` cookie (HMAC under
`BETTER_AUTH_SECRET`, 1 hour, path `/api/sign/{token}`, bound to the Recipient and the
link's hash, so a reminder's fresh link needs a fresh code). Decline needs the grant too, so
a forwarded link alone cannot close an Envelope. Content on a completion link needs no code.
Access-log entries use `actorUserId` = the RecipientId, `documentId`, IP and user agent, with
actions `read` (open), `unlock` (code, verify), `read-content`, `download` (signed PDF) and
`write` (sign, decline). A link packages/auth cannot attribute (unknown, or replaced by a
reminder or completion) is the same 404 but logged nowhere. Codes are stored as
HMAC-SHA256 of `recipientId|code`; a right code is used up. Date Fields take the server's
UTC date `YYYY-MM-DD`; the `signed` event records text, date and checkbox values as typed,
signature and initials images as `{ sha256 }`, plus `consent` (the exact `CONSENT_TEXT`).
"Next field" walks required, unfilled Fields only. The sign mutation calls the private
`beginCompletion(ref, envelope, origin)` (not `markAllSigned`, since it is already inside a
mutation); decline calls `stopLifecycle(ref)`.

**Web routes:** `/envelopes` (list), `/envelopes/:id` (draft editor or status page),
`/sign/:token` (signer page, no app shell, like `/s/:token`).

---

## T3.1 (#63): Envelope core: model, Durable Object, sender API, audit chain

**Context:** ADR-0006. Foundation for every other ticket.
**Acceptance criteria (predicates):**
- [ ] Migration `0010_envelopes.sql` creates the four tables in the shared contract; an `UPDATE` or `DELETE` on `audit_events` fails in D1 (test).
- [ ] `packages/domain` exports the Envelope schemas (Zod) and `auditHash(prev, event)` / `verifyChain(events)`; a test pins one event's hash and shows that changing any field of an earlier event makes `verifyChain` report the first broken `seq`.
- [ ] An `Envelope` DO (`v3-envelope`, named `{tenantId}/{envelopeId}`) is the only writer of the four tables: writes live in `@inkly/storage/envelopes`, and lint fails an import of it from anywhere but the DO module (`pnpm lint:fixtures` proves it).
- [ ] GIVEN an editor WHEN they create an Envelope from a Document, PUT recipients and fields and send it THEN it is `sent`, its `audit_events` are `created`, `sent`, then one `notified` per signer whose turn it is, the chain verifies, and each such signer has an Outbox email with a `/sign/{43-char token}` link whose sha256 is the only token value stored.
- [ ] GIVEN sequential order THEN only routing order 1 is notified at send.
- [ ] Send is refused (422 `invalid_input`) with no signer, a signer without a signature field, a field on a page the Version lacks, or a field assigned to a CC; a sent Envelope refuses PUT and DELETE (409).
- [ ] GIVEN a Free Tenant that sent 3 Envelopes this month THEN the 4th send returns 402 `limit_exceeded` and nothing changes; drafts are not counted. Concurrent sends cannot overshoot.
- [ ] Void moves `sent` to `voided`, audits it with the reason and emails pending signers; a voided Envelope's links stop working (T3.3 checks the signer side).
- [ ] `GET …/audit` returns the events in `seq` order with `chain.valid: true`; tampering a row directly in a test makes it `false`.
- [ ] Viewers can list and read, writes return 403 (logged); a Member of another Tenant gets 404 for every route (add to `verify-tenancy`).

**Verification:** `pnpm test` (DO + D1 via `vitest-pool-workers`); `verify-tenancy`; `pnpm check`; `pnpm lint:fixtures`.
**Out of scope:** UI (T3.2), signer routes (T3.3), finalize (T3.5).
**Risk:** high (signing, tenancy, a new DO).

## T3.2 (#64): Place fields and send from the browser

**Dependencies:** T3.1.
**Acceptance criteria (predicates):**
- [ ] GIVEN the viewer on a Document THEN "Send for signature" creates a draft and opens `/envelopes/:id`.
- [ ] GIVEN the draft editor THEN the sender adds recipients (name, email, signer/CC, order), switches parallel/sequential, picks a recipient and places signature, initials, date, text and checkbox fields on any page by click or drag, moves, resizes and deletes them, and each recipient's fields share a distinct, contrast-checked color. Changes save (PUT) without a Save button and survive a reload.
- [ ] GIVEN a draft that would be refused by send THEN the editor names the problem (e.g. "Ana Ruiz has no signature field") and Send is disabled.
- [ ] GIVEN Send THEN the page becomes the status page: each recipient's status and times, the audit trail with "Audit trail verified", Remind and Void (with a reason); `/envelopes` lists the Envelope with its status.
- [ ] Keyboard: a focused field moves with arrow keys and deletes with Delete; every control has a label; 0 axe violations in light and dark.
- [ ] `verify-app J-016` drives this and passes.

**Verification:** `verify-app J-016`; `pnpm test` (pure layout/geometry helpers); `pnpm check`.
**Out of scope:** templates, bulk send, field formulas.
**Risk:** medium.

## T3.3 (#65): Sign by email link and code

**Dependencies:** T3.1.
**Acceptance criteria (predicates):**
- [ ] `packages/auth` resolves a signer token to `{ tenantId, envelopeId, recipientId }`; it is the only place a signer token becomes a `TenantId` (lint already forbids minting elsewhere).
- [ ] GIVEN a signer opens `/sign/{token}` THEN they see the title, sender and "Email me a code", and `GET …/content` returns 401 until they verify.
- [ ] GIVEN "Email me a code" THEN the Outbox has a 6-digit code that expires in 10 minutes; a 6th send within 10 minutes returns 429; 5 wrong codes invalidate the code; a right code sets the 1-hour signer grant and audits `verified` with IP and user agent.
- [ ] GIVEN a verified signer THEN the Document renders with only their fields active, "Next field" walks them in page order, signature/initials open an adopt dialog (type in the script face or draw), date fills itself, and Finish is enabled once every required field has a value and the consent box is ticked; signing audits `signed` and the page says it is done.
- [ ] GIVEN sequential order WHEN signer 1 signs THEN signer 2 gets their email (`notified`), and not before.
- [ ] GIVEN Decline with a reason THEN the Envelope is `declined`, the sender gets an email, other links stop working, and the audit has `declined`.
- [ ] GIVEN a voided, declined, expired or unknown token, or one already used to sign THEN the API returns 404 (or the done state for the signer who signed) with no detail about why; a token for Envelope X never reads Envelope Y, and a signer cannot set another recipient's field (422, logged). Add these to `verify-tenancy`.
- [ ] The signer page works at 320 px wide and has 0 axe violations; `verify-app J-018` (decline, then void another) passes.

**Verification:** `pnpm test`; `verify-app J-018`; `verify-tenancy`; `pnpm check`.
**Out of scope:** SMS codes, ID verification, in-person signing, signer attachments.
**Risk:** high (unauthenticated path).

## T3.4 (#66): Stamp, certify and seal a PDF

**Context:** ADR-0006 "Completion". Pure `packages/pdf`; no Envelope dependency.
**Acceptance criteria (predicates):**
- [ ] `stampFields(bytes, fields)` draws signature/initials PNGs, text, dates and checkmarks into their rects (rotation respected); `verify-pdf` passes and the text values are in the page text.
- [ ] `appendCertificate(bytes, certificate)` adds Certificate of completion pages listing the Envelope, original sha256, each Recipient (name, email, method, IP, user agent, times, signature image) and every audit event with its hash; long trails wrap to more pages.
- [ ] `sealPdf(bytes, { privateKey, certificate })` returns bytes with one PAdES B-B signature covering the whole file; `pyhanko sign validate --trust <cert>` reports it INTACT and VALID, and changing one byte makes it fail. Runs in workerd (test in `test/workerd`).
- [ ] `generateSealKey()` produces a P-256 key and self-signed certificate (used by tests and test hooks); `scripts/seal-key.sh` prints the two PEMs for `wrangler secret put`.
- [ ] `verify-pdf --signed <cert.pem>` adds the pyHanko check; CI installs pyHanko.

**Verification:** `pnpm test` (incl. workerd); `verify-pdf --signed`; `pnpm check`.
**Out of scope:** PAdES B-T/B-LT timestamps, signer-level certificates.
**Risk:** high (signing output).

## T3.5 (#67): Complete an Envelope

**Dependencies:** T3.1, T3.4.
**Acceptance criteria (predicates):**
- [ ] Sending starts an `EnvelopeLifecycle` Workflow instance (id = Envelope id). It reminds pending signers every 3 days (audits `reminded`, Outbox email), expires the Envelope at `expires_at` (audits `expired`), and ends on void or decline. Tested with Workflow introspection.
- [ ] GIVEN the last signer signs THEN the Envelope goes `completing`, then `completed`: a new Version of the Document holds the stamped pages plus the certificate, passes `verify-pdf --signed`, and `completed` carries its sha256; `final_version` names it.
- [ ] A finalize step that fails (e.g. no seal key in production) leaves the Envelope `completing` and retries; running finalize twice adds one Version.
- [ ] GIVEN completion THEN every Recipient and the sender get an email; recipient links download the signed PDF for 30 days; `GET /api/envelopes/:id/content` returns the sealed PDF; `GET /api/seal-certificate` returns the PEM.
- [ ] Previews get a fresh seal key pair per environment from `preview.yml`; production config check fails if `SEAL_PRIVATE_KEY` appears in a committed file.

**Verification:** `pnpm test`; `verify-pdf --signed`; `pnpm check`.
**Risk:** high.

## T3.6 (#68): verify-signing

**Dependencies:** T3.2, T3.3, T3.5.
**Acceptance criteria (predicates):**
- [ ] `.claude/skills/verify-signing/` (SKILL.md + `run.sh`, `--url` for previews) drives a full Envelope through the API with two signers using Outbox codes and fails unless: the signed PDF passes `qpdf --check` and pyHanko (INTACT, VALID against `/api/seal-certificate`); its page count is the original's plus the certificate pages; the stamped text is in the page text; the audit chain recomputed with `verifyChain` matches `GET …/audit`; the `completed` event's sha256 equals the downloaded bytes.
- [ ] `--self-test` proves it fails on a tampered byte, a broken chain and a missing certificate.
- [ ] A `verify-signing` CI job runs it, `preview.yml` runs it against the preview, and `docs/ops/branch-protection.md` lists it.
- [ ] `verify-app J-017` (sender sends to two signers in sequence, both sign in separate browser contexts, sender downloads) passes; the success criterion "upload → 2 signers → signed PDF + certificate" is timed in the run output.

**Verification:** the skill itself, in CI and on a preview.
**Risk:** medium.

## T3.7: Phase 3 gate

- [ ] T3.1–T3.6 merged; `verify-app --all`, `verify-tenancy` and `verify-signing` green on a preview and on production after Siddartha approves the deploy and sets the seal secrets.
- [ ] Feature map, `GLOSSARY.md` and ADR-0006 match what shipped; hand-off note for Phase 4 posted.
