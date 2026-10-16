-- T2.3: Share links. Only the sha256 of a link's token is stored, so a leaked database
-- cannot open links. password_hash is a PBKDF2 string (see packages/auth share-links.ts).
CREATE TABLE share_links (
  tenant_id TEXT NOT NULL REFERENCES tenants (id),
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  password_hash TEXT,
  allow_download INTEGER NOT NULL CHECK (allow_download IN (0, 1)),
  revoked_at INTEGER,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id)
);
CREATE INDEX share_links_document ON share_links (tenant_id, document_id, created_at);

-- Entries written for a share-link visitor name the link and where the request came from.
ALTER TABLE access_log ADD COLUMN share_link_id TEXT;
ALTER TABLE access_log ADD COLUMN ip TEXT;
ALTER TABLE access_log ADD COLUMN user_agent TEXT;
CREATE INDEX access_log_share_link ON access_log (tenant_id, share_link_id, id);
