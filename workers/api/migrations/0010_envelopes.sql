-- T3.1: Envelopes (ADR-0006). The Envelope Durable Object is the only writer of these four
-- tables, through @inkly/storage/envelopes. Recipient and Field ids are unique within their
-- Envelope. Only the sha256 of a signer token or code is stored.
CREATE TABLE envelopes (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'sent', 'completing', 'completed', 'declined', 'voided', 'expired')
  ),
  order_mode TEXT NOT NULL CHECK (order_mode IN ('parallel', 'sequential')),
  expires_in_days INTEGER NOT NULL DEFAULT 30 CHECK (expires_in_days BETWEEN 1 AND 90),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  expires_at INTEGER,
  completed_at INTEGER,
  final_version INTEGER,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id, version)
    REFERENCES document_versions (tenant_id, document_id, n)
);
CREATE INDEX envelopes_by_updated ON envelopes (tenant_id, updated_at, id);
CREATE INDEX envelopes_by_status ON envelopes (tenant_id, status, updated_at, id);
CREATE INDEX envelopes_by_document ON envelopes (tenant_id, document_id);

CREATE TABLE recipients (
  tenant_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('signer', 'cc')),
  routing_order INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (
    status IN ('waiting', 'sent', 'viewed', 'signed', 'declined')
  ),
  token_hash TEXT UNIQUE,
  notified_at INTEGER,
  viewed_at INTEGER,
  signed_at INTEGER,
  declined_at INTEGER,
  decline_reason TEXT,
  code_hash TEXT,
  code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  verified_ip TEXT,
  verified_user_agent TEXT,
  PRIMARY KEY (tenant_id, envelope_id, id),
  FOREIGN KEY (tenant_id, envelope_id) REFERENCES envelopes (tenant_id, id)
);

CREATE TABLE fields (
  tenant_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('signature', 'initials', 'date', 'text', 'checkbox')),
  page INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL,
  h REAL NOT NULL,
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0, 1)),
  value TEXT,
  PRIMARY KEY (tenant_id, envelope_id, id),
  FOREIGN KEY (tenant_id, envelope_id) REFERENCES envelopes (tenant_id, id),
  FOREIGN KEY (tenant_id, envelope_id, recipient_id)
    REFERENCES recipients (tenant_id, envelope_id, id)
);
CREATE INDEX fields_by_recipient ON fields (tenant_id, envelope_id, recipient_id);

-- Append-only and hash-chained per subject: hash = sha256(prev_hash + "\n" + canonical
-- JSON of the event), see packages/domain audit.ts. detail is canonical JSON.
CREATE TABLE audit_events (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('envelope')),
  subject_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (tenant_id, subject_type, subject_id, seq)
);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
