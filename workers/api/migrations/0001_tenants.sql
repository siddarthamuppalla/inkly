-- ADR-0004: every tenant-owned row carries tenant_id; tenants carry a region (Q2).
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  region TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL
);
