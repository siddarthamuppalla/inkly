---
status: accepted
date: 2026-10-15
---

# 0003 — Auth provider: Better-Auth, self-hosted on D1

We use Better-Auth as a library inside our Worker, storing users, sessions and
verification tokens in our own D1, wrapped by `packages/auth` as the only paved road.
We chose it over Clerk because it has no per-MAU cost (budget ceiling is $25/mo
total), keeps user data inside the isolation model of ADR-0004, and its organization
plugin maps directly onto Tenant/Member, whereas Clerk would put a paid, hosted
dependency on the critical path and require syncing its org model with ours.

## Decisions

- **Sign-in methods at launch:** email magic link / one-time code, and Google OAuth.
  No passwords at launch (no password storage, reset or breach-check surface).
- **Sessions:** HTTP-only, `Secure`, `SameSite=Lax` cookies; session rows in D1.
- **Tenancy:** Better-Auth organizations = Tenants, members = Members (roles owner,
  admin, editor, viewer). `packages/auth` resolves the **Active tenant** from the
  session, checks membership, and is the only module that mints a `TenantId`.
- **Signers are not Users.** Envelope recipients authenticate per-envelope (email
  link + OTP, Phase 3) and never get a session; that flow is designed in ADR-0006.

## Consequences

- We own rate limiting on sign-in endpoints, session revocation, and library
  upgrades. Rate limits live in KV via `packages/auth`.
- Magic links require the email provider (Q5); local dev and tests use a captured
  outbox instead of real email.
- SSO/SAML (later phase) is available as a Better-Auth plugin, so it does not force a
  provider change.

## Considered options

- **Clerk** — least code and polished UI; rejected for paid-tier risk against the
  budget, lock-in, and user data outside our D1.
