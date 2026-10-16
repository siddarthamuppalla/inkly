-- T2.4: Document activity. Entries that concern a Document name it, so a Document's
-- activity is one indexed range scan.
ALTER TABLE access_log ADD COLUMN document_id TEXT;

-- Backfill from the resource text earlier entries carry:
-- "document <id> v<n>" / "document <id>" (content reads, share-link visits) and
-- "<METHOD> /api/documents/<id>[/...]" (refusals).
UPDATE access_log
SET document_id = substr(resource, 10, instr(substr(resource, 10) || ' ', ' ') - 1)
WHERE document_id IS NULL AND resource LIKE 'document %';

UPDATE access_log
SET document_id = substr(
  substr(resource, instr(resource, ' /api/documents/') + 16),
  1,
  instr(substr(resource, instr(resource, ' /api/documents/') + 16) || '/', '/') - 1
)
WHERE document_id IS NULL
  AND instr(resource, ' /api/documents/') > 0
  AND substr(resource, instr(resource, ' /api/documents/') + 16) GLOB 'doc_[A-Za-z0-9]*';

CREATE INDEX access_log_document ON access_log (tenant_id, document_id, id);
