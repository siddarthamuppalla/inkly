---
status: accepted
date: 2026-10-15
---

# 0002 — Frontend: React + Vite SPA on Workers static assets

`apps/web` is a client-only React single-page app built with Vite and served as
Workers static assets. It talks to `workers/api` over HTTP only. We chose a SPA over
React Router v7 framework mode (SSR on a Worker) because the product sits behind
login and the PDF.js viewer renders client-side, so SSR buys little, and a pure
client keeps the boundary `apps/web ↛ workers/* / packages/storage` trivially
enforceable while avoiding a second server runtime.

## Decisions

- **Routing:** React Router v7 in data (library) mode.
- **Server state:** TanStack Query. No global client store unless a ticket justifies one.
- **UI:** Tailwind CSS + shadcn/ui (components copied into the repo, not a runtime dependency).
- **Viewer:** PDF.js (`pdfjs-dist`), worker loaded from our own static assets.
- **API contract:** request/response shapes are Zod schemas in `packages/domain`,
  shared by web and API; the web app never imports Worker code.
- **Public pages** (marketing, legal) are static HTML added later, not SSR.

## Consequences

- Slower first paint than SSR for logged-out pages; acceptable because the signer
  and app flows are interactive anyway. Revisit if public share-link pages need SEO.
- `verify-app` drives the built SPA against `wrangler dev`, the same artifact that ships.

## Considered options

- **React Router v7 framework mode (SSR)** — rejected: second runtime, blurrier
  web/API boundary, little benefit behind login.
