// Auto-merge for agent PRs (docs/ops/auto-merge.md). Merges a PR only when every guardrail
// holds: an agent branch from the repo owner, no stop label or factory pause, no protected
// path touched, no journey dropped from the feature map, a bounded diff, and every check on
// the head commit green, including verify-app --all against the PR's Cloudflare preview.
// Branch protection still applies to the merge itself; this script only decides when to ask.
//
// usage: node scripts/auto-merge.mjs <pr-number> [--dry-run]
// env: GH_TOKEN, GH_REPO (owner/name), FACTORY_PAUSED, GITHUB_STEP_SUMMARY
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** Check runs that must exist and pass on the head commit (ci.yml jobs and preview.yml). */
export const REQUIRED_CHECKS = [
  "check",
  "test",
  "verify-pdf",
  "verify-perf",
  "verify-app",
  "verify-tenancy",
  "audit",
  "prod-config",
  "secrets",
  "workflows",
  "verdict",
  "preview",
];

/** Labels that keep a PR for a human. */
export const STOP_LABELS = ["risk:high", "needs-human", "no-automerge", "factory-pause"];

/** Most changed lines (additions + deletions) a PR may have and still merge on its own. */
export const MAX_CHANGED_LINES = 2000;

/**
 * Paths whose changes always need a human: the guardrails and verifiers themselves, deploy
 * and production config, schema migrations, the tenancy and auth paved roads, dependencies
 * and the perf baseline. Journey files and the feature map stay open, since every feature
 * PR adds to them; dropping a journey is caught separately.
 */
const PROTECTED = [
  /^\.github\//,
  /^scripts\//,
  /^CLAUDE\.md$/,
  /^docs\/ops\//,
  /^\.claude\/(?!skills\/verify-app\/feature-map\.md$)/,
  /^packages\/testing\/(?!src\/app\/[\w-]+\.ts$)/,
  /^packages\/testing\/src\/app\/(runner|route-coverage|feature-map|local-server|self-test-server|sign-in)\.ts$/,
  /^packages\/auth\//,
  /^packages\/storage\//,
  /\/migrations\//,
  /(^|\/)wrangler\.jsonc?$/,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.nvmrc$/,
];

export const isProtected = (path) => PROTECTED.some((re) => re.test(path));

/** Journey IDs in a feature-map.md body, as verify-app reads them. */
export function journeyIds(markdown) {
  return markdown
    .split("\n")
    .map((l) => /^\|\s*(J-\d{3})\s*\|/.exec(l)?.[1])
    .filter((id) => id !== undefined);
}

/** The newest run of each check name (a re-run adds a run with the same name). */
function latestByName(checks) {
  const latest = new Map();
  for (const c of checks) {
    const seen = latest.get(c.name);
    if (!seen || c.id > seen.id) latest.set(c.name, c);
  }
  return latest;
}

const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * Pure decision. `blockers` need a change to the PR (or a human); `waiting` clears on its
 * own as checks finish. Merge only when both are empty.
 * @param {{
 *   pr: {
 *     state: string, isDraft: boolean, baseRefName: string, headRefName: string,
 *     isCrossRepository: boolean, author: { login: string }, labels: { name: string }[],
 *     body: string, additions: number, deletions: number, changedFiles: number,
 *     files: { path: string }[], mergeStateStatus: string,
 *   },
 *   repoOwner: string,
 *   paused: boolean,
 *   checks: { id: number, name: string, status: string, conclusion: string | null }[],
 *   baseJourneys: string[],
 *   headJourneys: string[],
 * }} facts
 */
export function decide({ pr, repoOwner, paused, checks, baseJourneys, headJourneys }) {
  const blockers = [];
  const waiting = [];

  if (pr.state !== "OPEN") blockers.push(`the PR is ${pr.state.toLowerCase()}`);
  if (pr.isDraft) blockers.push("the PR is a draft");
  if (pr.baseRefName !== "main") blockers.push(`the base is ${pr.baseRefName}, not main`);
  if (pr.isCrossRepository) blockers.push("the PR comes from a fork");
  if (!/^(t|claude)\/./.test(pr.headRefName)) {
    blockers.push(`branch ${pr.headRefName} is not an agent branch (t/* or claude/*)`);
  }
  if (pr.author.login !== repoOwner)
    blockers.push(`the author is ${pr.author.login}, not ${repoOwner}`);
  if (paused) blockers.push("the factory is paused (factory-pause or FACTORY_PAUSED)");
  for (const label of pr.labels.map((l) => l.name).filter((l) => STOP_LABELS.includes(l))) {
    blockers.push(`labelled ${label}`);
  }
  if (!/^#+\s*Verification Evidence/im.test(pr.body)) {
    blockers.push("the PR body has no Verification Evidence section");
  }

  const lines = pr.additions + pr.deletions;
  if (lines > MAX_CHANGED_LINES) {
    blockers.push(`${String(lines)} changed lines, over the ${String(MAX_CHANGED_LINES)} limit`);
  }
  if (pr.files.length !== pr.changedFiles) {
    blockers.push(
      `only ${String(pr.files.length)} of ${String(pr.changedFiles)} changed files could be read`,
    );
  }
  const touched = pr.files.map((f) => f.path).filter(isProtected);
  if (touched.length > 0) blockers.push(`touches protected paths: ${touched.join(", ")}`);

  const dropped = baseJourneys.filter((id) => !headJourneys.includes(id));
  if (dropped.length > 0)
    blockers.push(`removes journeys from feature-map.md: ${dropped.join(", ")}`);

  const latest = latestByName(checks.filter((c) => c.name !== "auto-merge"));
  for (const name of REQUIRED_CHECKS) {
    if (!latest.has(name)) waiting.push(`${name} has not reported`);
  }
  for (const c of latest.values()) {
    if (c.status !== "completed") waiting.push(`${c.name} is ${c.status.replace("_", " ")}`);
    else if (!PASSING.has(c.conclusion ?? ""))
      blockers.push(`${c.name} is ${String(c.conclusion)}`);
  }
  // "skipped" passes for optional checks, but a required one must have really run.
  for (const name of REQUIRED_CHECKS) {
    if (latest.get(name)?.conclusion === "skipped") blockers.push(`${name} was skipped`);
  }

  if (pr.mergeStateStatus === "BEHIND") blockers.push("the branch is behind main: update it");
  else if (pr.mergeStateStatus === "DIRTY") blockers.push("the branch has merge conflicts");

  return { merge: blockers.length === 0 && waiting.length === 0, blockers, waiting };
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
/** REST only: every page of a list endpoint, flattened. */
const pages = (path) => JSON.parse(gh("api", "--paginate", "--slurp", path)).flat();

function readFacts(number, repo) {
  const raw = JSON.parse(gh("api", `repos/${repo}/pulls/${String(number)}`));
  const pr = {
    state: raw.merged ? "MERGED" : raw.state.toUpperCase(),
    isDraft: raw.draft,
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    headRefOid: raw.head.sha,
    isCrossRepository: raw.head.repo?.full_name !== repo,
    author: { login: raw.user.login },
    labels: raw.labels.map((l) => ({ name: l.name })),
    body: raw.body ?? "",
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changed_files,
    files: pages(`repos/${repo}/pulls/${String(number)}/files?per_page=100`).map((f) => ({
      path: f.filename,
    })),
    mergeStateStatus: String(raw.mergeable_state).toUpperCase(),
  };
  const checks = pages(`repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`).flatMap(
    (page) => page.check_runs,
  );
  const featureMap = (ref) =>
    journeyIds(
      gh(
        "api",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${repo}/contents/.claude/skills/verify-app/feature-map.md?ref=${ref}`,
      ),
    );
  const pauseIssues = pages(`repos/${repo}/issues?labels=factory-pause&state=open&per_page=100`);
  return {
    pr,
    repoOwner: repo.split("/")[0],
    paused: process.env.FACTORY_PAUSED === "true" || pauseIssues.length > 0,
    checks,
    // From the merge base, so a branch that is merely behind main does not read as dropping
    // the journeys main added since.
    baseJourneys: featureMap(
      JSON.parse(gh("api", `repos/${repo}/compare/${pr.baseRefName}...${pr.headRefOid}`))
        .merge_base_commit.sha,
    ),
    headJourneys: featureMap(pr.headRefOid),
  };
}

const MARKER = "<!-- inkly-auto-merge -->";

function report(number, repo, text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
  const comments = pages(`repos/${repo}/issues/${String(number)}/comments?per_page=100`);
  const mine = comments.find((c) => c.body?.startsWith(MARKER));
  const body = `${MARKER}\n${text}`;
  if (mine?.body === body) return;
  if (mine)
    gh(
      "api",
      "-X",
      "PATCH",
      `repos/${repo}/issues/comments/${String(mine.id)}`,
      "-f",
      `body=${body}`,
    );
  else
    gh(
      "api",
      "-X",
      "POST",
      `repos/${repo}/issues/${String(number)}/comments`,
      "-f",
      `body=${body}`,
    );
}

function main() {
  const [arg, flag] = process.argv.slice(2);
  const number = Number(arg);
  const repo = process.env.GH_REPO;
  if (!Number.isInteger(number) || number <= 0 || !repo) {
    console.error("usage: GH_REPO=owner/name node scripts/auto-merge.mjs <pr-number> [--dry-run]");
    process.exit(2);
  }
  const facts = readFacts(number, repo);
  const { merge, blockers, waiting } = decide(facts);
  const sha = facts.pr.headRefOid.slice(0, 7);
  const list = (items) => items.map((i) => `- ${i}`).join("\n");
  if (flag === "--dry-run") {
    console.log(JSON.stringify({ merge, blockers, waiting }, null, 2));
    return;
  }
  if (blockers.length > 0) {
    report(
      number,
      repo,
      `**Auto-merge** on ${sha}: not merging, a human needs to look.\n\n${list(blockers)}`,
    );
    return;
  }
  if (waiting.length > 0) {
    report(number, repo, `**Auto-merge** on ${sha}: waiting for checks.\n\n${list(waiting)}`);
    return;
  }
  // `sha` makes GitHub refuse the merge if anything was pushed after these checks ran, and
  // branch protection still applies to it.
  gh(
    "api",
    "-X",
    "PUT",
    `repos/${repo}/pulls/${String(number)}/merge`,
    "-f",
    `sha=${facts.pr.headRefOid}`,
    "-f",
    "merge_method=merge",
  );
  report(number, repo, `**Auto-merge** merged ${sha}: every guardrail and check passed.`);
  // A merge made with the workflow token starts no push workflows, so start them here. The
  // production deploy still waits for a human on the production environment.
  for (const workflow of ["ci.yml", "deploy.yml"]) {
    gh(
      "api",
      "-X",
      "POST",
      `repos/${repo}/actions/workflows/${workflow}/dispatches`,
      "-f",
      "ref=main",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
