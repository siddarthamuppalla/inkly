"""Structural check for T0.1 deliverables: ADRs 0001-0004, grilling log, Phase 0 tickets, glossary.

Run from the repo root: python3 scripts/check-t01-docs.py
"""
import json
import os
import re
import sys

ok = True


def fail(msg):
    global ok
    ok = False
    print("FAIL", msg)


for n, slug in [(1, "monorepo-and-tooling"), (2, "frontend-framework"), (3, "auth-provider"), (4, "tenant-isolation")]:
    p = f"docs/adr/{n:04d}-{slug}.md"
    if not os.path.exists(p):
        fail(p)
        continue
    t = open(p).read()
    if "status: accepted" not in t or "date:" not in t:
        fail(p + " frontmatter")

log = open("docs/decisions/T0.1-grilling-log.md").read()
for kw in ["Product name", "Frontend", "Auth provider", "Email provider", "Pricing", "Team, timeline", "Data residency"]:
    if kw.lower() not in log.lower():
        fail("log missing " + kw)
rows = re.findall(r"^\| Q(\d+) ", log, re.M)
if rows != [str(i) for i in range(1, 13)]:
    fail(f"log rows {rows}")

t = open("docs/tickets/phase-0.md").read()
parts = re.split(r"^## (T0\.\d+) ", t, flags=re.M)
found = {parts[i]: parts[i + 1] for i in range(1, len(parts), 2)}
if list(found) != [f"T0.{i}" for i in range(2, 11)]:
    fail(f"tickets {list(found)}")
for k, b in found.items():
    for f in ["**Context:**", "**Acceptance criteria (predicates):**", "**Verification:**", "**Out of scope:**", "**Dependencies:**", "**Risk:**"]:
        if f not in b:
            fail(f"{k} missing {f}")
    acs = re.findall(r"^- \[ \] (.*)", b, re.M)
    if not acs:
        fail(k + " no ACs")
    for a in acs:
        if not (a.startswith("GIVEN") and "THEN" in a):
            fail(f"{k} non-predicate AC: {a[:70]}")
    verification = b.split("**Verification:**")[1].split("**Out of scope")[0]
    if "```" not in verification:
        fail(k + " no verification commands")
    print(k, len(acs), "ACs")

g = open("GLOSSARY.md").read()
for term in ["Active tenant", "TenantId", "Region", "Plan", "Limit", "Usage", "Preview environment", "Test hooks", "Outbox"]:
    if f"**{term}**" not in g:
        fail("glossary " + term)

goal = open("docs/factory/01_GOAL.md").read()
if "Open decisions" in goal or "[$X]" in goal:
    fail("01_GOAL still lists open decisions")

json.load(open(".claude/settings.json"))
print("ALL OK" if ok else "FAILED")
sys.exit(0 if ok else 1)
