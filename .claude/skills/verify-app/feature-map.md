# Feature map

One row per user journey. Every feature PR adds or updates its rows, and the
journey's automation in `packages/testing/src/app/journeys.ts` under the same ID.
`verify-app` refuses an ID that is not listed here.

| ID | Journey | Steps | Expected | Spec |
|----|---------|-------|----------|------|
| J-000 | Health check | open / → GET /health | 200, all bindings true; SPA shell renders; 0 console errors | #7 |
