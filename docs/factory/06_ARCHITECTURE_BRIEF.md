# Architecture Brief (seed — refine via grilling + ADRs)

## Shape
```
Browser (React + PDF.js)
   │ HTTPS
   ▼
Worker: api (Hono) ──► D1 (metadata)      KV (sessions, flags, rate limits)
   │   │                R2 (files: tenants/{tid}/docs/{did}/v{n}.pdf)
   │   ├─► Durable Object: Envelope (signing state machine, per envelope)
   │   ├─► Durable Object: DocSession (realtime annotations/presence)
   │   ├─► Queues ──► Worker: jobs ──► Container: pdf-engine (qpdf, gs, pyHanko, LibreOffice, Tesseract)
   │   ├─► Workflows (envelope lifecycle, reminders, retention purge)
   │   └─► Browser Rendering (HTML→PDF)
   ▼
Stripe, Email provider, Sentry
```

## Monorepo layout
```
apps/web                 # frontend
workers/api              # HTTP API
workers/jobs             # queue consumers
containers/pdf-engine    # heavy PDF ops (HTTP service)
packages/domain          # types, branded IDs, pure logic (no I/O)
packages/storage         # ONLY path to R2/D1 (tenant-scoped)
packages/pdf             # pdf-lib ops safe for Workers
packages/auth            # session + permission checks
packages/testing         # fixtures, factories, verify helpers
.claude/skills/          # project skills (verify-*, etc.)
docs/adr, docs/notes, docs/runs
```

## Core data model (D1, seed)
- `tenants(id, name, plan, created_at)`
- `users(id, email, name, created_at)` · `memberships(tenant_id, user_id, role)`
- `folders(id, tenant_id, parent_id, name)`
- `documents(id, tenant_id, folder_id, title, current_version, status, deleted_at)`
- `document_versions(id, document_id, n, r2_key, sha256, bytes, pages, created_by, created_at)`
- `share_links(id, tenant_id, document_id, token_hash, expires_at, password_hash, allow_download)`
- `envelopes(id, tenant_id, document_id, status, order_mode, created_by, completed_at, final_version_id)`
- `recipients(id, envelope_id, email, name, role, order, status, auth_method)`
- `fields(id, envelope_id, recipient_id, type, page, x, y, w, h, value)`
- `audit_events(id, tenant_id, subject_type, subject_id, actor, action, ip, ua, at, prev_hash, hash)` — **append-only, hash-chained**
- `jobs(id, tenant_id, kind, status, input, output, error, created_at)`
- `usage(tenant_id, period, ops, storage_bytes, envelopes)`

Every tenant-owned row carries `tenant_id`; every query goes through `packages/storage`
which requires a `TenantId` (branded type).

## Key constraints to respect
- Worker memory 128 MB and CPU limits → large PDFs/ops go to Containers via Queues.
- D1 per-DB size limit → plan sharding (per-tenant or per-region DBs) before GA; ADR needed.
- R2: use multipart for large uploads; presigned URLs short-lived; never expose raw keys.
- Durable Objects are the single writer for envelope state; audit events written from the DO.
- Idempotency keys on all job enqueues and Stripe webhooks.

## ADRs to write first
0001 Monorepo & tooling · 0002 Frontend framework · 0003 Auth provider ·
0004 Tenant isolation strategy · 0005 PDF processing split (Worker vs Container) ·
0006 Signing model & audit hash chain · 0007 D1 scaling/sharding · 0008 Storage key scheme
