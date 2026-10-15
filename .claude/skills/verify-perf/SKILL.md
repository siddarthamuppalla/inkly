---
name: verify-perf
description: Time the PDF ops (merge, split, rotate, reorder, compress) on 50p.pdf and fail on a p95 over 3 s or a regression against perf-baseline.json. Use after any change to packages/pdf, containers/pdf-engine or their dependencies, and in CI.
---

# verify-perf

Performance gate from `docs/factory/04_VERIFICATION.md` (T1.5). Paste its table into
the PR's Verification Evidence block.

## When to run it
- After changing `packages/pdf`, `containers/pdf-engine`, `pdf-lib`, or the fixtures.
- CI runs it and `--self-test` on every PR (job `verify-perf`).

## Requirements
Node 22, `pnpm i` already run, and `qpdf` and `ghostscript` on PATH (pdf-engine needs
them). On Ubuntu: `sudo apt-get install -y qpdf ghostscript`.

## Usage
```
.claude/skills/verify-perf/run.sh                    # measure and gate
.claude/skills/verify-perf/run.sh --update-baseline  # rewrite perf-baseline.json
.claude/skills/verify-perf/run.sh --self-test        # prove the gate fires
.claude/skills/verify-perf/run.sh --url URL          # not yet: exits 2
```

| Flag | Meaning |
|------|---------|
| `--update-baseline` | Measure twice, keep each op's higher p95, and write `perf-baseline.json`. Commit it only with a reason in the PR. |
| `--self-test` | Measure, then check the gate against fabricated inputs: the results must pass against themselves, a baseline 10x faster must trip the regression rule, and a fabricated 3001 ms p95 must trip the bound. Exits 0 only if all three hold. |
| `--url URL` | Reserved for timing a deployed environment. It exits 2 with "not yet: needs page-op API (T1.3b)" until that API exists. |
| `-h`, `--help` | Print usage. |

Exit codes: `0` pass, `1` gate failed or error, `2` not available (`--url`).

## What it measures
Each op runs once to warm up, then 10 timed runs, one after another (wall clock).

| Op | How |
|----|-----|
| `merge 50p+10p` | `@inkly/pdf` `merge`, in process |
| `split 50p into 5` | `split` into pages 1–10, 11–20, …, 41–50 |
| `rotate 50p all pages` | `rotate` every page by 90° |
| `reorder 50p reversed` | `reorder` to 50, 49, …, 1 |
| `compress 50p ebook` | local `containers/pdf-engine`, `POST /compress?level=ebook` |
| `compress huge-image ebook` | the same with `huge-image.pdf` |

Each run checks the op did the work (5 split parts, a `200` from the engine), so a
broken op cannot look fast. The page ops run in Node, not workerd, so they show
trends in our code and `pdf-lib`, not Worker CPU time.

## The gate
Percentiles are nearest-rank. With 10 runs, p95 is the slowest run.

An op fails when:
1. **Bound (hard gate):** its p95 is over 3000 ms; or
2. **Regression (trend guard):** its p95 is more than 20% above the baseline p95
   **and** more than 50 ms above it. The 50 ms floor stops a 10 ms op failing on
   timer and scheduler noise; a 20% regression on fast ops shows up once it is
   big enough to matter; or
3. it has no baseline entry.

Because one slow run sets p95, an op that fails is measured again (10 more runs) and
keeps the pass with the lower p95. It fails only if both passes fail. The constants
live in `packages/testing/src/perf/stats.ts`.

## The baseline
`perf-baseline.json` was generated on the Claude Code cloud container that built
T1.5 (Linux, 4 x Intel Xeon 2.10 GHz; see its `generatedOn`), not on a GitHub runner.
CI runners may be slower or faster. The 3 s bound is the hard gate; the regression
rule guards trends. If CI fails only on regression and the PR did not touch PDF code,
the runner differs from this machine: regenerate the baseline on a runner and commit
it with that reason.

## Implementation
`run.sh` runs `packages/testing/bin/verify-perf.ts` with Node's type stripping. The
logic is in `packages/testing/src/perf/` (`stats.ts` gate, `ops.ts` benchmark,
`engine.ts` starts pdf-engine); tests in `packages/testing/test/perf-stats.test.ts`.
