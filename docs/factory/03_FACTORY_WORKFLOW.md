# Factory Workflow — Decide → Build → Verify

## Principles
1. **Trust before parallelism.** Throughput comes from agents producing acceptable
   work unsupervised. Trust comes from verification. Scale agents only after.
2. **Verification first.** If an agent can't prove it works, it isn't done.
3. **Decide, then build.** Humans own *what*; agents own *how*, inside gates.
4. **The codebase is the agent's memory.** Make the right path the only path.
5. **Every failure upgrades the factory.** Retro turns mistakes into rules, tests or skills.

## Pipeline
| # | Stage | Skills | Output | Gate |
|---|-------|--------|--------|------|
| 1 | Grill | `grill-with-docs` | Decisions; `GLOSSARY.md` + ADRs updated | 👤 |
| 2 | Model | `domain-modeling`, `architect` | Types, interfaces, schema diff | 👤 |
| 3 | Spec | `to-spec` | GitHub issue with acceptance criteria as **predicates** | 👤 |
| 4 | Ticket | `to-tickets` / `wayfinder` | Vertical-slice tickets + dependencies; label `ready-for-agent` | 👤 |
| 5 | Build | `poteto-mode` → `how` → `tdd` | Red → green → refactor in a worktree | auto |
| 6 | Verify | `verify-*` skills | Verification Evidence in PR | auto |
| 7 | Review | fresh agent: `interrogate` + `code-review` | Verdict comment | auto + 👤 |
| 8 | Merge | human | — | 👤 |
| 9 | Retro | `retro` | Environment-improvement PRs | — |

### Ticket template (required fields)
```
Title: <verb> <thing>
Context: why, links to spec/ADR
Acceptance criteria (predicates):
  - [ ] GIVEN … WHEN … THEN … (observable, checkable)
Verification:
  - commands / verify-* skills to run and expected results
Out of scope:
Dependencies: #…
Risk: low | medium | high   (high = touches signing, tenancy, billing, storage keys)
```
A ticket without checkable predicates is **not ready**.

### Playbooks (via `poteto-mode`)
- **Bug:** reproduce (failing test or verify script) → `diagnosing-bugs` → fix → same repro passes → regression test kept.
- **Feature:** `how` → `architect` → `tdd` slice by slice → verify → PR.
- **Investigation:** read-only; `how`/`why`/`research`; output a cited note in `docs/notes/`.
- **Big/unclear:** `figure-it-out` or `wayfinder` → produce decision tickets first.

## Fix-layer ladder (always prefer the highest available)
1. **Architecture** — make it unrepresentable (branded `TenantId`, storage only via `packages/storage`).
2. **Static** — type rules, lint rules, import boundaries, CI checks.
3. **Tests** — unit, integration (real bindings), E2E.
4. **Skills / CLAUDE.md rules** — guidance (can be ignored by agents).
5. **Human review** — finds gaps; doesn't scale.

When fixing a mistake, state: *"Fixed at layer N because …; layers above were not feasible because …"*.

## Codebase rules
- One paved road per concern (storage, jobs, auth checks, PDF ops, errors, logging). Delete alternatives.
- No explanatory comments covering bugs (`no-comments`); rationale lives in ADRs/tests.
- Deep modules, small interfaces (`codebase-design`).
- Boundaries: `apps/web` ↛ `workers/*` internals; Workers ↛ R2/D1 except through `packages/*` adapters.
- Pay down debt before it spreads — agents copy existing patterns.

## Branching & PRs
- Branch: `t/<issue#>-<slug>`; one ticket per worktree.
- Small commits; PR body follows `.github/pull_request_template.md`.
- Builder never approves its own PR. A new commit invalidates prior verdicts.

## Decision log
Long/autonomous runs write `docs/runs/<date>-<ticket>.tsv` via `show-me-your-work`.
Any assumption made because an input was blocked is flagged `ASSUMPTION` for human review.

## Metrics (weekly)
Accepted PRs, rework rate, escaped defects, human review minutes/PR, cost per accepted change,
verification flake rate. Promote bot phases only when these justify it.
