# Glossary (keep updated — agents must use these terms)

| Term | Meaning |
|------|---------|
| **Tenant** | A paying workspace/organization; the isolation boundary for all data |
| **Member** | A user belonging to a tenant with a role (owner, admin, editor, viewer) |
| **Document** | A logical file owned by a tenant; has one or more versions |
| **Version** | An immutable PDF byte stream in R2 with sha256; edits create new versions |
| **Page op** | A structural change: merge, split, rotate, reorder, delete, insert |
| **Annotation** | Non-destructive overlay (highlight, comment, drawing) until flattened |
| **Flatten** | Burn annotations/form values into page content, producing a new version |
| **Envelope** | A signing request: one document + recipients + fields + lifecycle |
| **Recipient** | A party on an envelope: signer, approver, or CC |
| **Field** | A placed input on a page (signature, initials, date, text, checkbox) |
| **Audit trail** | Append-only, hash-chained events for a subject (document/envelope) |
| **Certificate of completion** | PDF summary of an envelope's audit trail appended to the signed doc |
| **Share link** | Tokenized, optionally expiring/password-protected access to a document |
| **Job** | Async unit of work on a Queue, possibly executed in the pdf-engine Container |
| **pdf-engine** | Container service for heavy PDF ops |
| **Paved road** | The single sanctioned way to do a concern in the codebase |
| **Verification Evidence** | Required PR block proving acceptance criteria hold |
| **Feature map** | Catalogue of user journeys verified by `verify-app` |
| **Gate (👤)** | A pipeline step requiring explicit human confirmation |
| **Builder / Verifier** | Agent that writes the change / separate agent that judges it |
| **Fix-layer ladder** | Architecture → static → tests → skills → human review |
