# Feature map

One row per user journey. Every feature PR adds or updates its rows, and the
journey's automation in `packages/testing/src/app/journeys.ts` under the same ID.
`verify-app` refuses an ID that is not listed here.

| ID | Journey | Steps | Expected | Spec |
|----|---------|-------|----------|------|
| J-000 | Health check | open / → GET /health | 200, all bindings true; SPA shell renders; 0 console errors | #7 |
| J-001 | Design system reference | open /design → Tab → Enter | h1 and every section render; title "Design system · Inkly"; first Tab is the skip link with a ≥2px outline; Enter moves focus to #main; no horizontal scroll at 320px; 0 axe violations in light and dark | #23 |
| J-003 | Upload, view and download a PDF | sign in → / → Upload PDF (10p.pdf) → open it → Download | list row shows 10 pages; viewer renders 10 pages and 10 thumbnails; download is named 10p.pdf and its sha256 equals the fixture's; 0 axe violations in light and dark | T1.2 |
| J-004 | Folders | sign in → upload tiny.pdf → New folder "Contracts" → open tiny → Folder: Contracts → Move → / → open Contracts → New folder "2026" → open it | folder listed; viewer reads "Now in: Contracts"; top level no longer lists tiny; Contracts lists it; folder path reads Contracts / 2026; 0 axe violations | T1.2 |
| J-005 | Versions | sign in → upload 10p.pdf → open → Upload new version (tiny.pdf) → Restore version 1 | v2 shows 1 page; restore adds Version 3 marked Current with 10 pages; viewer renders 10 pages; v3's bytes equal 10p.pdf; 0 axe violations | T1.2 |
