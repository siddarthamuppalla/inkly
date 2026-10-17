-- T1.4b: Jobs, the async work the API enqueues and workers/jobs runs (06_ARCHITECTURE_BRIEF).
-- A Job moves queued -> running -> committing -> succeeded, or to failed from any state
-- before succeeded. `committing` records the sha256 of the bytes about to become a Version,
-- so a redelivered message can tell whether that Version already exists.
CREATE TABLE jobs (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  id TEXT NOT NULL,
  -- One Job per key per Tenant: enqueueing the same key again returns the existing Job.
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('compress')),
  document_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'committing', 'succeeded', 'failed')),
  -- JSON: what to do, e.g. {"level":"ebook","fromVersion":3}.
  input TEXT NOT NULL,
  -- JSON once succeeded, e.g. {"version":4,"bytesBefore":2107452,"bytesAfter":181220}.
  output TEXT,
  error TEXT,
  -- Bumped by every delivery that starts work; a delivery commits only if it still owns the latest attempt.
  attempts INTEGER NOT NULL DEFAULT 0,
  commit_sha256 TEXT,
  committing_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);
CREATE INDEX jobs_document ON jobs (tenant_id, document_id, created_at);
