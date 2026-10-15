// Proves each architecture lint rule still fires: every case is copied to the
// location named in its header, linted there, and must report the expected rule.
import { copyFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const casesDir = join(root, "tools/lint-fixtures/cases");
const eslint = new ESLint({ cwd: root });

let failures = 0;
for (const file of readdirSync(casesDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()) {
  const source = readFileSync(join(casesDir, file), "utf8");
  const target = /lint-fixture target: (\S+)/.exec(source)?.[1];
  const expected = /lint-fixture expect: (\S+)/.exec(source)?.[1];
  if (!target || !expected) {
    console.error(`FAIL ${file}: missing lint-fixture header`);
    failures++;
    continue;
  }
  const targetPath = join(root, target);
  copyFileSync(join(casesDir, file), targetPath);
  try {
    const [result] = await eslint.lintFiles([targetPath]);
    const ruleIds = (result?.messages ?? []).map((m) => m.ruleId);
    const architectureIds = ruleIds.filter(
      (id) => id?.startsWith("boundaries/") || id?.startsWith("inkly/"),
    );
    if (expected === "none" ? architectureIds.length === 0 : ruleIds.includes(expected)) {
      console.log(
        `ok   ${file}: ${expected === "none" ? "no architecture rule fired" : `${expected} fired`} at ${target}`,
      );
    } else {
      console.error(`FAIL ${file}: expected ${expected}, got [${ruleIds.join(", ")}]`);
      failures++;
    }
  } finally {
    rmSync(targetPath, { force: true });
  }
}
process.exit(failures === 0 ? 0 : 1);
