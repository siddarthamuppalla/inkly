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

**Region**: Where a Tenant's data is stored; only `default` exists until EU residency is built.

**Plan**: The billing tier of a Tenant (`free` or `pro`); it determines Limits.

**Limit**: A per-Plan cap (members, storage, file size, page ops, envelopes) enforced server-side.

**Usage**: A Tenant's metered consumption per billing period, checked against its Limits.
_Avoid_: quota, credits

## Documents

**Document**: A logical file owned by a tenant; has one or more versions.

**Version**: An immutable PDF byte stream in R2 with sha256; edits create new versions.

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

**pdf-engine**: Container service for heavy PDF ops.

## Factory

**Preview environment**: An isolated per-PR deployment (`inkly-pr-<n>`) with its own Worker, D1, R2 and KV; destroyed when the PR closes.
_Avoid_: staging

**Test hooks**: The `/__test/*` routes (seed tenant/users, read Outbox) that exist only in dev and Preview environments.

**Outbox**: Captured outgoing email in dev/test/preview instead of real delivery; read by verification skills.

**Paved road**: The single sanctioned way to do a concern in the codebase.

**Verification Evidence**: Required PR block proving acceptance criteria hold.

**Feature map**: Catalogue of user journeys verified by `verify-app`.

**Gate (👤)**: A pipeline step requiring explicit human confirmation.

**Builder / Verifier**: Agent that writes the change / separate agent that judges it.

**Fix-layer ladder**: Architecture → static → tests → skills → human review.
