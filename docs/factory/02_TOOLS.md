# Tools — Stack, Skills, Plugins, CLIs

> Pin exact versions in `package.json` / lockfiles. Defaults below; change via ADR.

## 1. Agent harness
| Tool | Use |
|------|-----|
| **Claude Code** (CLI + cloud sessions) | Primary builder/verifier agents |
| Claude Code **scheduled tasks** | Time-based bots (Chief of Staff, Retro) |
| **GitHub Actions** (+ Claude Code Action) | Event-based bots (Triage, Verifier, PR Watcher), CI |
| Git **worktrees** | One ticket = one worktree = one branch |

## 2. Skill packs (install exactly ONE copy of each skill)

### Option A (recommended): official Matt Pocock + a pstack port
```bash
# Matt Pocock — deciding half (grilling, specs, tickets, TDD, diagnosis)
claude plugin install mattpocock-skills@claude-plugins-official
# then in the repo:
/setup-matt-pocock-skills      # issue tracker = GitHub Issues, docs = docs/

# pstack (Lauren Tan / poteto) — building + verifying half (community port)
/plugin marketplace add michael-denyer/pstack-claude
/plugin install pstack@pstack-claude
/pstack:setup-pstack           # choose budget: balanced
```
### Option B: single bundle
`techRambam/pstack-cc` bundles pstack + Matt's core skills + cross-vendor review panels.
Clone it, then `claude plugin marketplace add <path>` and `claude plugin install pstack-cc@pstack-cc`.

> pstack is Cursor-native; all Claude Code versions are community ports.
> Verify install commands against the chosen repo's README. Don't install A and B together.

### Skills we rely on
| Phase | Skill | Source |
|-------|-------|--------|
| Decide | `grill-me`, `grill-with-docs`, `grilling` | Matt |
| Decide | `domain-modeling`, `codebase-design`, `improve-codebase-architecture` | Matt |
| Decide | `to-spec`, `to-tickets`, `wayfinder`, `to-questionnaire` | Matt |
| Decide | `prototype`, `research` | Matt |
| Route | `poteto-mode` (playbook router), `figure-it-out` | pstack |
| Understand | `how`, `why` | pstack |
| Design | `architect` | pstack |
| Build | `tdd`, `implement`, `implement-spec` | Matt |
| Build | `arena` (multiple attempts, best-of), `swarm`, `orch` | pstack |
| Debug | `diagnosing-bugs` | Matt |
| Review | `interrogate` (multi-model), `code-review`, `no-comments` | pstack / Matt |
| PR | `pr`, `watch-pr`, `technical-writing`, `unslop` | Matt / pstack |
| Memory | `show-me-your-work` (decision log), `handoff`, `retro` | pstack / Matt |
| Ops | `triage`, `wizard` (human-only steps) | Matt |

### Project-owned skills (we build these — see `04_VERIFICATION.md`)
`verify-app`, `verify-pdf`, `verify-signing`, `verify-tenancy`, `verify-perf`, `cf-deploy-preview`.
Live in `.claude/skills/<name>/SKILL.md`.

## 3. Product stack (Cloudflare-native)
| Layer | Choice | Notes |
|-------|--------|-------|
| Language | TypeScript (strict) | everywhere |
| Monorepo | pnpm workspaces + Turborepo | |
| Frontend | [React + Vite / React Router v7] on Workers static assets | PDF.js viewer |
| API | Cloudflare Workers + **Hono** | Zod validation |
| DB | **D1** + **Drizzle ORM** | migrations via drizzle-kit/wrangler |
| Files | **R2** | tenant-prefixed keys, presigned URLs |
| Cache/flags/sessions | **KV** | |
| Realtime + signing envelope state | **Durable Objects** | one DO per envelope / document session |
| Async jobs | **Queues** | conversion, compression, email, OCR |
| Long workflows | **Workflows** | envelope lifecycle, retention |
| Heavy processing | **Cloudflare Containers** | qpdf, Ghostscript, LibreOffice, Tesseract, pyHanko |
| HTML → PDF | **Browser Rendering** | |
| AI (later) | Workers AI / Claude API | field extraction, summaries |
| PDF libs (Worker) | pdf-lib, PDF.js | lightweight ops only |
| Auth | [Better-Auth / Clerk] | decide in grilling |
| Email | [Resend / Postmark] | |
| Payments | Stripe | |
| Observability | Workers Logs + Logpush, Sentry | |

## 4. Quality & verification tooling
| Tool | Purpose |
|------|---------|
| Vitest + `@cloudflare/vitest-pool-workers` | unit + integration with real bindings |
| Playwright | E2E, traces, screenshots against `wrangler dev` / preview |
| ESLint (+ custom rules), `eslint-plugin-boundaries` or dependency-cruiser | import boundaries |
| TypeScript `--strict`, `noUncheckedIndexedAccess` | |
| Prettier | |
| `qpdf --check` | PDF structural validity |
| veraPDF | PDF/A compliance |
| pyHanko | signature validation |
| pdftoppm + pixelmatch | visual regression on rendered pages |
| k6 or custom bench | perf budgets |
| Gitleaks, `npm audit`/Socket | secrets + supply chain |

## 5. CLIs
`wrangler`, `gh`, `pnpm`, `turbo`, `drizzle-kit`, `qpdf`, `pdftoppm` (poppler), `verapdf`, `pyhanko`, `docker`.

## 6. Connectors / MCP (optional)
GitHub (required), Sentry, Slack, Linear (if not using GitHub Issues), Cloudflare MCP server for bindings/logs.
