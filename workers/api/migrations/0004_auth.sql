-- T1.1 / ADR-0003: Better-Auth on D1. Users become global; memberships are per tenant.
-- Better-Auth's organization plugin uses `tenants` as its organization table.
-- Phase 0 users and sessions came only from test seeding and are dropped, not migrated.
PRAGMA defer_foreign_keys = true;

DROP TABLE sessions;
DROP TABLE users;

-- Rebuild tenants with the organization columns; created_at becomes an ISO-8601 string,
-- the format Better-Auth writes on SQLite.
CREATE TABLE tenants_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  region TEXT NOT NULL DEFAULT 'default',
  created_at DATE NOT NULL
);
INSERT INTO tenants_new (id, name, slug, plan, region, created_at)
SELECT id, name, id, plan, region, strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch')
FROM tenants;
DROP TABLE tenants;
ALTER TABLE tenants_new RENAME TO tenants;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL,
  image TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  expires_at DATE NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  active_tenant_id TEXT
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at DATE,
  refresh_token_expires_at DATE,
  scope TEXT,
  password TEXT,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  updated_at DATE NOT NULL
);
CREATE INDEX verifications_identifier_idx ON verifications (identifier);

-- A Member: one User's role in one Tenant.
CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at DATE NOT NULL,
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT,
  status TEXT NOT NULL,
  expires_at DATE NOT NULL,
  created_at DATE NOT NULL,
  inviter_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX invitations_tenant_id_idx ON invitations (tenant_id);
CREATE INDEX invitations_email_idx ON invitations (email);

-- Q5: captured outgoing email (dev, tests, previews). Read only through test hooks.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX outbox_to_email ON outbox (to_email, id);
