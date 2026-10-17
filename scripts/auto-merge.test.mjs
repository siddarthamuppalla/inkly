// node --test scripts/auto-merge.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decide,
  isProtected,
  journeyIds,
  MAX_CHANGED_LINES,
  REQUIRED_CHECKS,
} from "./auto-merge.mjs";

const green = REQUIRED_CHECKS.map((name, i) => ({
  id: i + 1,
  name,
  status: "completed",
  conclusion: "success",
}));

function facts(overrides = {}) {
  const { pr, ...rest } = overrides;
  return {
    pr: {
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "t/41-annotations",
      isCrossRepository: false,
      author: { login: "owner" },
      labels: [],
      body: "## Summary\nx\n\n## Verification Evidence\n| a | b |",
      additions: 300,
      deletions: 20,
      changedFiles: 2,
      files: [
        { path: "workers/api/src/annotations.ts" },
        { path: "apps/web/src/routes/document.tsx" },
      ],
      mergeStateStatus: "CLEAN",
      ...pr,
    },
    repoOwner: "owner",
    paused: false,
    checks: green,
    baseJourneys: ["J-000", "J-003"],
    headJourneys: ["J-000", "J-003", "J-010"],
    ...rest,
  };
}

const blockersOf = (f) => decide(f).blockers;

describe("decide", () => {
  it("merges a green agent PR that touches only feature code", () => {
    assert.deepEqual(decide(facts()), { merge: true, blockers: [], waiting: [] });
  });

  it("waits while a required check has not reported or is still running", () => {
    const checks = [
      ...green.filter((c) => c.name !== "preview" && c.name !== "test"),
      { id: 99, name: "test", status: "in_progress", conclusion: null },
    ];
    const d = decide(facts({ checks }));
    assert.equal(d.merge, false);
    assert.deepEqual(d.blockers, []);
    assert.deepEqual(d.waiting.sort(), ["preview has not reported", "test is in progress"]);
  });

  it("blocks on any failed check, required or not, using the newest run of each", () => {
    const failed = [
      ...green,
      { id: 100, name: "verify-app", status: "completed", conclusion: "failure" },
    ];
    assert.deepEqual(blockersOf(facts({ checks: failed })), ["verify-app is failure"]);
    const extra = [
      ...green,
      { id: 101, name: "lint-bot", status: "completed", conclusion: "cancelled" },
    ];
    assert.deepEqual(blockersOf(facts({ checks: extra })), ["lint-bot is cancelled"]);
    const rerun = [
      { id: 0, name: "verify-app", status: "completed", conclusion: "failure" },
      ...green,
    ];
    assert.equal(decide(facts({ checks: rerun })).merge, true);
  });

  it("blocks a required check that was skipped (preview without Cloudflare secrets)", () => {
    const checks = green.map((c) => (c.name === "preview" ? { ...c, conclusion: "skipped" } : c));
    assert.deepEqual(blockersOf(facts({ checks })), ["preview was skipped"]);
  });

  it("ignores its own check run", () => {
    const checks = [
      ...green,
      { id: 200, name: "auto-merge", status: "in_progress", conclusion: null },
    ];
    assert.equal(decide(facts({ checks })).merge, true);
  });

  for (const label of ["risk:high", "needs-human", "no-automerge", "factory-pause"]) {
    it(`blocks a PR labelled ${label}`, () => {
      assert.deepEqual(blockersOf(facts({ pr: { labels: [{ name: label }] } })), [
        `labelled ${label}`,
      ]);
    });
  }

  it("blocks while the factory is paused", () => {
    assert.deepEqual(blockersOf(facts({ paused: true })), [
      "the factory is paused (factory-pause or FACTORY_PAUSED)",
    ]);
  });

  it("blocks drafts, forks, other bases, other authors and non-agent branches", () => {
    assert.deepEqual(blockersOf(facts({ pr: { isDraft: true } })), ["the PR is a draft"]);
    assert.deepEqual(blockersOf(facts({ pr: { isCrossRepository: true } })), [
      "the PR comes from a fork",
    ]);
    assert.deepEqual(blockersOf(facts({ pr: { baseRefName: "release" } })), [
      "the base is release, not main",
    ]);
    assert.deepEqual(blockersOf(facts({ pr: { author: { login: "stranger" } } })), [
      "the author is stranger, not owner",
    ]);
    assert.deepEqual(blockersOf(facts({ pr: { headRefName: "feature/x" } })), [
      "branch feature/x is not an agent branch (t/* or claude/*)",
    ]);
    assert.deepEqual(blockersOf(facts({ pr: { state: "MERGED" } })), ["the PR is merged"]);
  });

  it("blocks a PR with no Verification Evidence section", () => {
    assert.deepEqual(blockersOf(facts({ pr: { body: "## Summary\nTrust me." } })), [
      "the PR body has no Verification Evidence section",
    ]);
  });

  it("blocks a diff over the size limit, or one whose file list was cut short", () => {
    assert.deepEqual(blockersOf(facts({ pr: { additions: MAX_CHANGED_LINES, deletions: 1 } })), [
      `${String(MAX_CHANGED_LINES + 1)} changed lines, over the ${String(MAX_CHANGED_LINES)} limit`,
    ]);
    assert.deepEqual(blockersOf(facts({ pr: { changedFiles: 150 } })), [
      "only 2 of 150 changed files could be read",
    ]);
  });

  it("blocks a PR that drops a journey from the feature map", () => {
    assert.deepEqual(blockersOf(facts({ headJourneys: ["J-000"] })), [
      "removes journeys from feature-map.md: J-003",
    ]);
  });

  it("blocks a branch that is behind main or conflicted", () => {
    assert.deepEqual(blockersOf(facts({ pr: { mergeStateStatus: "BEHIND" } })), [
      "the branch is behind main: update it",
    ]);
    assert.deepEqual(blockersOf(facts({ pr: { mergeStateStatus: "DIRTY" } })), [
      "the branch has merge conflicts",
    ]);
  });

  it("names every protected path a PR touches", () => {
    const files = [{ path: ".github/workflows/ci.yml" }, { path: "apps/web/src/main.tsx" }];
    assert.deepEqual(blockersOf(facts({ pr: { files, changedFiles: 2 } })), [
      "touches protected paths: .github/workflows/ci.yml",
    ]);
  });
});

describe("isProtected", () => {
  const protectedPaths = [
    ".github/workflows/auto-merge.yml",
    "scripts/auto-merge.mjs",
    "scripts/deploy-production.sh",
    "CLAUDE.md",
    "docs/ops/auto-merge.md",
    ".claude/skills/verify-app/run.sh",
    ".claude/skills/verify-app/SKILL.md",
    ".claude/skills/verify-perf/perf-baseline.json",
    ".claude/settings.json",
    "packages/testing/src/app/runner.ts",
    "packages/testing/src/app/route-coverage.ts",
    "packages/testing/src/app/sign-in.ts",
    "packages/testing/src/app/local-server.ts",
    "packages/testing/src/app/feature-map.ts",
    "packages/testing/src/app/self-test-server.ts",
    "packages/testing/src/pdf/verify.ts",
    "packages/testing/bin/verify-app.ts",
    "packages/testing/src/tenancy/attacks.ts",
    "packages/auth/src/index.ts",
    "packages/storage/src/documents.ts",
    "workers/api/migrations/0008_share_links.sql",
    "workers/api/wrangler.jsonc",
    "apps/web/package.json",
    "pnpm-lock.yaml",
  ];
  for (const path of protectedPaths) {
    it(`protects ${path}`, () => assert.equal(isProtected(path), true));
  }
  const open = [
    ".claude/skills/verify-app/feature-map.md",
    "packages/testing/src/app/journeys.ts",
    "packages/testing/src/app/documents.ts",
    "packages/testing/src/app/page-ops.ts",
    "packages/testing/src/app/forms.ts",
    "workers/api/src/documents.ts",
    "apps/web/src/routes/document.tsx",
    "packages/pdf/src/forms.ts",
    "docs/tickets/phase-2.md",
    "GLOSSARY.md",
    "fixtures/pdfs/forms.pdf",
  ];
  for (const path of open) {
    it(`leaves ${path} open`, () => assert.equal(isProtected(path), false));
  }
});

describe("journeyIds", () => {
  it("reads the ID column of feature-map rows only", () => {
    const md =
      "| ID | Journey |\n|----|---|\n| J-000 | Health |\n| J-013 | Trash |\nJ-099 in prose\n";
    assert.deepEqual(journeyIds(md), ["J-000", "J-013"]);
  });
});
