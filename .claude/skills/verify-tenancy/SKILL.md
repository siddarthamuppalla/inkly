---
name: verify-tenancy
description: Attack tenant isolation end to end. As tenant A, try to read, write, list and fetch tenant B's data; every attempt must be denied and logged. Use for any change touching storage, auth, or a tenant-scoped route, and in CI.
---

# verify-tenancy

Gate for ADR-0004 (tenant isolation). It seeds two fresh tenants, A and B, through
the test hooks. B creates a folder, a Document in it and a Document in Trash; A creates
its own folder and Document. Then A tries to reach B's data every known way:
- by id, and by claiming B's tenant in the `x-inkly-tenant` header or the `?tenant=` query;
- by renaming, moving, trashing and restoring B's Documents, and moving its own
  Document into B's folder;
- by listing B's Documents, folder contents and folders;
- by fetching B's content and Version content (the R2 objects);
- by listing, adding and restoring B's Versions;
- by reading and filling B's form fields;
- by uploading into, nesting under, renaming, moving into and deleting B's folder;
- by listing, adding, recoloring, deleting, commenting on and resolving B's Annotations,
  downloading B's Document with annotations, and opening B's live annotations WebSocket.

Pass means every attempt returned 403 or 404. A's access log must hold exactly one
denial entry per denied attempt, and B's Documents and folders must be unchanged.
Control requests also confirm that A can reach its own Document, content, Versions,
form fields, Annotations, live WebSocket and folder (and that its three content reads were logged), so a broken route can't pass as a
denial.

## When to run it
- Any change to `packages/storage`, `packages/auth`, or a tenant-scoped route.
- Each new tenant-scoped resource (documents, share links, envelopes, search,
  webhooks) adds its own attack cases to `packages/testing/src/tenancy/attack.ts`.
- CI runs it and `--self-test` on every PR.

## Usage
```
.claude/skills/verify-tenancy/run.sh                          # local wrangler dev
.claude/skills/verify-tenancy/run.sh --url URL --secret S     # e.g. a preview
.claude/skills/verify-tenancy/run.sh --self-test
```

| Flag | Meaning |
|------|---------|
| `--url URL` | Target a running environment instead of starting `wrangler dev`. It needs test hooks enabled there. |
| `--secret S` | That environment's test-hooks secret. Defaults to `$TEST_HOOKS_SECRET`. |
| `--self-test` | Starts `wrangler dev` with `VERIFY_TENANCY_SELFTEST=leak`, which makes `resolveTenant` trust the client's tenant header (only when test hooks are on). Exits 0 only if the attack detects the leak. |
| `-h`, `--help` | Print usage. |

It prints a table of attempts with their statuses. Exit codes: `0` pass, `1` a leak
or check failure. For `--self-test`, `0` means the leak was caught.

## What it attacks today
`/api/documents` (`workers/api/src/documents.ts`), its Annotation routes and
DocSession WebSocket (`workers/api/src/annotations.ts`) and `/api/folders`
(`workers/api/src/folders.ts`). Add cases to `attack.ts` when a new tenant-scoped
route ships.
