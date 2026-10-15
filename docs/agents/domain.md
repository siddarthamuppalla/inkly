# Domain Docs

How the engineering skills should consume this repo's domain documentation.

This repo is **single-context**, with one deliberate deviation from the skill defaults: the
glossary is **`GLOSSARY.md`** at the repo root, not `CONTEXT.md`. Wherever a skill says
`CONTEXT.md`, read and write `GLOSSARY.md` instead, using the same format (bold term, one-line
definition, `_Avoid_:` synonyms).

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.
- **`docs/decisions/`**: grilling logs that record smaller decisions not worth an ADR.
- **`docs/factory/`**: the kickoff pack (goal, workflow, verification, roadmap).

## Use the glossary's vocabulary

When your output names a domain concept (issue title, proposal, hypothesis, test name), use the
term as defined in `GLOSSARY.md`. Don't drift to synonyms it lists under `_Avoid_`. If the concept
isn't in the glossary yet, either you're inventing language the project doesn't use (reconsider)
or there's a real gap (add it via `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0004 (tenant isolation), but worth reopening because…_
