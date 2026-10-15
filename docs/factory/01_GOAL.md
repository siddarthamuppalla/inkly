# Goal — Inkly

## Vision
A multi-tenant SaaS on Cloudflare that owns the full document lifecycle —
**create, edit, convert, organize, fill, sign, share, track, download, archive** —
as one fast, affordable alternative to Acrobat + DocuSign + Smallpdf.

The project is also a **software factory**: the codebase, verification skills and
bots are product in their own right, built so agents can ship trustworthy work
with minimal supervision.

## Target users
- **Primary:** SMBs and freelancers handling contracts, invoices, proposals, forms.
- **Secondary:** teams needing approval workflows; developers needing an API (later).

## Capabilities (full vision)
1. **Create** — blank, templates, HTML/Markdown → PDF; Office/image → PDF.
2. **View & edit** — fast in-browser viewer; annotate, comment, highlight; page ops; text/image edits (later).
3. **Organize** — merge, split, compress, rotate, reorder, watermark, page numbers, flatten, redact.
4. **Forms** — fill, build fillable forms, pre-fill from data.
5. **E-signature** — multi-signer, sequential/parallel, field placement, email/OTP verification,
   tamper-evident audit trail, completion certificate. ESIGN/UETA/eIDAS (SES) compliant.
6. **Manage** — folders, tags, full-text search (OCR later), version history, trash/retention.
7. **Share & download** — secure expiring/password links, download controls, PDF/A and image export, bulk ZIP.
8. **Collaborate** — workspaces, roles, comments, activity feed.
9. **Security** — encryption in transit/at rest, PDF passwords, access logs, SSO (later).
10. **Billing** — Free / Pro / Team via Stripe with usage limits.
11. **API & webhooks** — later phase.

## MVP scope (target: rapid iteration after a ~1-day Phase 0)
- Auth, workspaces, tenant isolation
- Upload / view / download PDFs; folders
- Merge, split, rotate, reorder, compress
- Annotations + form filling
- E-signature (multi-signer) + audit trail + completion certificate
- Secure share links
- Free/Pro billing (Stripe)

**Out of MVP:** full text editing, Office conversion, OCR, public API, SSO,
mobile apps, AES/QES signatures.

## Success criteria
| Area | Criterion |
|------|-----------|
| Signing | Upload → 2 signers → signed PDF + certificate in < 2 min of user time |
| Performance | Common ops on a 50-page PDF < 3 s p95 |
| Correctness | All produced PDFs pass `qpdf --check`; signed PDFs validate in pyHanko |
| Security | Zero cross-tenant access in `verify-tenancy`; every file access authorized and logged |
| Cost | Infra ≤ $25/mo total pre-launch ($5 Workers Paid + $20 usage) |
| Quality | ≥ 80% coverage on PDF + signing core; E2E for every feature-map journey |
| Factory | Rework rate < [20]%, escaped defects trending down, human review time per PR trending down |

## Non-goals
- Being a general cloud drive.
- Building our own PDF renderer from scratch (use PDF.js / pdf-lib / proven engines).
- Qualified signatures in v1.

## Decisions (resolved in T0.1 grilling, 2026-10-15)
See `docs/decisions/T0.1-grilling-log.md` and `docs/adr/`.
- Product name: Inkly (public brand/domain before beta) · Frontend: React + Vite SPA (ADR-0002) ·
  Auth: Better-Auth on D1 (ADR-0003) · Email: Cloudflare Email Service, Resend free fallback
- Pricing: Free / Pro $12 — limits in the log (Q8)
- Budget: $25/mo total infra pre-launch · Timeline: Phase 0 in ~1 day, then rapid iteration ·
  Team: one human + ≤3 supervised agents
- Data residency: none at MVP; `tenants.region` reserved for EU later
