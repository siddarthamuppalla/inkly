---
status: accepted
date: 2026-10-15
---

# 0004 — Tenant isolation: shared D1, enforced by `packages/storage`

All tenants share one D1 database and one R2 bucket. Every tenant-owned row carries
`tenant_id`, and the only code path to D1 or R2 is `packages/storage`, whose API
requires a branded `TenantId`. We chose this over a D1 database per tenant because
per-tenant databases turn every migration into a fan-out across thousands of
databases, cannot be bound to a Worker dynamically, and complicate preview
environments and debugging, while the budget ceiling ($25/mo) rules out heavy
operational overhead.

## Rules

- **Users are global; memberships are per tenant.** A User may belong to many
  Tenants. Each request acts within exactly one **Active tenant**, resolved from the
  session and checked against `memberships` in `packages/auth` before any storage call.
- **`TenantId` is unforgeable outside `packages/auth`.** Only the auth layer mints a
  `TenantId` (after the membership check); everything else receives it.
- **R2 keys are built only in `packages/storage`:** `t/{tenantId}/d/{documentId}/v{n}`.
  Raw keys never leave the server; clients get short-lived signed URLs or streamed bytes.
- **Every tenant has a `region`** (only `default` for now; see Q2 in
  `docs/decisions/T0.1-grilling-log.md`) so EU-jurisdiction storage can be added
  without a schema change.
- **Cross-tenant access is a CI failure.** `verify-tenancy` attempts every read,
  write and list across two tenants and fails on any success.

## Consequences

- Isolation is logical, so it is only as strong as the paved road. Enforcement is
  pushed up the fix-layer ladder: branded types (architecture), an import-boundary
  lint that forbids `D1Database`/`R2Bucket` use outside `packages/storage` (static),
  and `verify-tenancy` (tests).
- D1's 10 GB per-database limit is the scaling ceiling. ADR-0007 decides sharding
  (by tenant or region) before GA; because every query already carries `TenantId`,
  routing to a shard is a change inside `packages/storage` only.

## Considered options

- **D1 per tenant** — strongest isolation; rejected for migration fan-out, binding
  limits and operational cost at our budget.
- **Row-level filtering by convention (no storage package)** — rejected; one missed
  `WHERE tenant_id = ?` is a cross-tenant leak, and agents copy patterns.
