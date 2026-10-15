-- Phase 0 sessions: bearer tokens issued by test seeding until Better-Auth (ADR-0003).
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  user_id TEXT NOT NULL REFERENCES users (id),
  expires_at INTEGER NOT NULL
);

-- T0.9 stub resource for verify-tenancy; replaced by real documents later.
CREATE TABLE stub_docs (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- Denied access attempts, keyed by the actor's tenant. Append-only.
CREATE TABLE access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  status INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX access_log_tenant ON access_log (tenant_id, id);
