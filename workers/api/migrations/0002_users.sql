-- Phase 0 users: enough for test seeding. Phase 1 (Better-Auth, ADR-0003) migrates
-- these rows into its own user and member tables.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant ON users (tenant_id);
