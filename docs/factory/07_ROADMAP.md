# Roadmap

## Phase 0 — Factory foundations (week 1–2)  ← START HERE
Goal: an agent can make a change and **prove** it works.
- T0.1 Grill session: resolve open decisions in `01_GOAL` → ADRs 0001–0004
- T0.2 Repo scaffold (monorepo, pnpm, turbo, TS strict, ESLint + boundaries, Prettier)
- T0.3 Reconcile the seed files at the repo root (CLAUDE.md, PR template, CI workflow)
- T0.4 Install skill packs; run `/setup-matt-pocock-skills`, `setup-pstack`
- T0.5 Hello-world Worker + D1 + R2 bindings; `vitest-pool-workers` test
- T0.6 Fixture PDF corpus + `verify-pdf` skill
- T0.7 `verify-app` skill + `feature-map.md` (J-000 health check)
- T0.8 `cf-deploy-preview` skill + preview environments
- T0.9 `verify-tenancy` skeleton (runs against stub endpoints)
- T0.10 CI gates required on PRs; metrics issue created
**Exit:** all verify skills green in CI for one week; one supervised PR merged with full evidence.

## Phase 1 — Core documents (week 3–5)
Auth + workspaces · upload (multipart) / view / download · folders · versioning ·
page ops (merge/split/rotate/reorder) in Worker · compress via Container ·
`verify-perf` baseline. Enable **Verifier + Builder bots**.

## Phase 2 — Forms, annotations, sharing (week 6–7)
Form fill · annotations + comments (DocSession DO) · secure share links ·
access logs. Enable **Triage + PR Watcher**.

## Phase 3 — E-signature (week 8–10)
Envelope DO + Workflows · field placement UI · signer flow (email/OTP) ·
hash-chained audit trail · completion certificate · `verify-signing`.

## Phase 4 — Billing & launch (week 11–12)
Stripe plans + usage limits · onboarding · legal pages · security review ·
load test · beta launch. Enable **Chief of Staff + parallel builders** if metrics allow.

## Later
Office conversion, OCR + full-text search, text editing, templates marketplace,
API + webhooks, SSO/SCIM, AES/QES, mobile, AI extraction.
