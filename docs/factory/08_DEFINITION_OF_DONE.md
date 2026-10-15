# Definition of Done

A ticket is done only when **all** are true:

### Correctness
- [ ] Every acceptance-criteria predicate checked and ticked in the PR
- [ ] TDD trail: tests were written failing first (or justified why not)
- [ ] Bugs: failing repro before fix, passing after; repro kept as regression test
- [ ] Verification Evidence block complete (see `04_VERIFICATION.md`)
- [ ] Relevant `verify-*` skills pass on a fresh checkout / preview deploy

### Quality
- [ ] `pnpm check` and `pnpm test` green; no new lint suppressions without ADR
- [ ] Uses the paved road (storage, jobs, auth, errors, logging) — no new parallel patterns
- [ ] No explanatory comments masking issues; rationale in ADR/tests
- [ ] Feature map updated for any new/changed user journey

### Safety
- [ ] All data access tenant-scoped via `packages/storage`
- [ ] Authorization checked and access logged for every file/document touch
- [ ] No secrets in code, logs or fixtures
- [ ] Cloudflare limits considered (CPU, memory, D1 size, R2 ops)

### Docs & memory
- [ ] ADR written for any significant decision
- [ ] `GLOSSARY.md` updated for new terms
- [ ] PR body uses the template; risk level stated

### Review
- [ ] Independent verifier verdict = PASS on the latest commit
- [ ] Human merge (until the area is cleared for auto-merge in `05_BOTS.md`)
