-- T1.2: Documents, Versions, folders and Usage (06_ARCHITECTURE_BRIEF data model).
-- Every row carries tenant_id; foreign keys include it, so no row can point across tenants.

DROP TABLE stub_docs;

CREATE TABLE folders (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES folders (tenant_id, id)
);
CREATE INDEX folders_parent ON folders (tenant_id, parent_id);

-- In Trash while deleted_at is set. last_version is the highest Version number handed
-- out; a writer claims the next one before writing to R2, so two writers never share a key.
CREATE TABLE documents (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  id TEXT NOT NULL,
  folder_id TEXT,
  title TEXT NOT NULL,
  current_version INTEGER NOT NULL CHECK (current_version >= 1),
  last_version INTEGER NOT NULL CHECK (last_version >= current_version),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, folder_id) REFERENCES folders (tenant_id, id)
);
CREATE INDEX documents_listing ON documents (tenant_id, folder_id, deleted_at, updated_at);

-- Inserted only after the Version's bytes are in R2 at r2_key.
CREATE TABLE document_versions (
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 1),
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  pages INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, document_id, n),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);

-- Metered consumption per billing period ('YYYY-MM', UTC). storage_bytes is the
-- Tenant's total stored Version bytes as of the last write in that period.
CREATE TABLE usage (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  period TEXT NOT NULL,
  ops INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  envelopes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
