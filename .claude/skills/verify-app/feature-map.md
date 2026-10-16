# Feature map

One row per user journey. Every feature PR adds or updates its rows, and the
journey's automation in `packages/testing/src/app/journeys.ts` under the same ID.
`verify-app` refuses an ID that is not listed here.

| ID | Journey | Steps | Expected | Spec |
|----|---------|-------|----------|------|
| J-000 | Health check | open / → GET /health | 200, all bindings true; SPA renders (app shell, or /sign-in when signed out); 0 console errors | #7 |
| J-001 | Design system reference | open /design → Tab → Enter | h1 and every section render; title "Design system · Inkly"; first Tab is the skip link with a ≥2px outline; Enter moves focus to #main; no horizontal scroll at 320px; 0 axe violations in light and dark | #23 |
| J-002 | Sign in with an email code | open / signed out → enter email → read code from the Outbox → enter code → sign out | / redirects to /sign-in; no Google button (unset); lands on / with the user menu; `GET /api/me` shows the email, Active tenant "<name>'s workspace" and role owner; sign-out returns to /sign-in and `/api/me` is 401 | T1.1 |
| J-008 | Invite a member | seeded Pro owner opens /members → invites an email → invitee opens the Outbox link → Accept → seeded Free owner invites | invitation confirmed and listed; invitee lands on / in the owner's workspace as editor and is listed as a member; a Free workspace shows "The Free plan allows 1 member" | T1.1 |
| J-003 | Upload, view and download a PDF | sign in → / → Upload PDF (10p.pdf) → open it → Download | list row shows 10 pages; viewer renders 10 pages and 10 thumbnails; download is named 10p.pdf and its sha256 equals the fixture's; 0 axe violations in light and dark | T1.2 |
| J-004 | Folders | sign in → upload tiny.pdf → New folder "Contracts" → open tiny → Folder: Contracts → Move → / → open Contracts → New folder "2026" → open it | folder listed; viewer reads "Now in: Contracts"; top level no longer lists tiny; Contracts lists it; folder path reads Contracts / 2026; 0 axe violations | T1.2 |
| J-005 | Versions | sign in → upload 10p.pdf → open → Upload new version (tiny.pdf) → Restore version 1 | v2 shows 1 page; restore adds Version 3 marked Current with 10 pages; viewer renders 10 pages; v3's bytes equal 10p.pdf; 0 axe violations | T1.2 |
| J-011 | Share a Document with a secure link | seeded Pro owner → open 10p → Share with a link (7 days, download on) → Share again (Never, password, download off) → sign out → open link 1 → Download → open link 2 → wrong password → right password → sign in → /links → Revoke link 1 → sign out → open link 1 | link URL is /s/ + 43-char token; viewer lists both links; signed-out link page has no app shell, renders 10 pages and downloads 10p.pdf (same sha256); password page names no Document, refuses a wrong password, then renders 10 pages with no Download and inline content; /links lists both with ≥1 open; revoked link page says "This link is no longer available"; 0 axe violations | T2.3 |
