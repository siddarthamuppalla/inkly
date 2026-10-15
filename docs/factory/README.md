# Inkly — Project Kickoff Pack (Software Factory)

Load these files into your Claude Project (Project → Knowledge) and paste
`00_PROJECT_INSTRUCTIONS.md` into the Project's **Custom Instructions** field.
Then start the first conversation with the prompt in `10_KICKOFF_PROMPT.md`.

| File | Purpose | Where it goes |
|------|---------|---------------|
| `00_PROJECT_INSTRUCTIONS.md` | How Claude must behave in every chat | Project → Custom Instructions |
| `01_GOAL.md` | Vision, users, scope, success criteria | Project Knowledge |
| `02_TOOLS.md` | Stack, skills, plugins, CLIs, versions | Project Knowledge |
| `03_FACTORY_WORKFLOW.md` | Decide→Build→Verify pipeline, gates, fix-layer rules | Project Knowledge |
| `04_VERIFICATION.md` | Verification skills spec + evidence format | Project Knowledge |
| `05_BOTS.md` | Bot roster, triggers, permissions, rollout phases | Project Knowledge |
| `06_ARCHITECTURE_BRIEF.md` | Cloudflare architecture, data model seed, constraints | Project Knowledge |
| `07_ROADMAP.md` | Phase plan + first tickets (Phase 0 → MVP) | Project Knowledge |
| `08_DEFINITION_OF_DONE.md` | DoD checklist + PR template | Project Knowledge |
| `09_GLOSSARY.md` | Shared domain vocabulary | Project Knowledge |
| `10_KICKOFF_PROMPT.md` | First message to send | Paste into first chat |
| `repo-seed/` | Files to commit to the repo on day 1 (CLAUDE.md, PR template, CI) | Git repo |

**Keep these files living.** When a decision changes, update the file (or an ADR)
and re-upload — the Project's knowledge is the factory's memory.
