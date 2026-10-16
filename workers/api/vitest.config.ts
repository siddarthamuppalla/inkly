import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const FIXTURES = ["10p.pdf", "tiny.pdf", "rotated.pdf", "encrypted.pdf", "malformed.pdf"];

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const fixtures = Object.fromEntries(
    FIXTURES.map((f) => [f, readFileSync(`../../fixtures/pdfs/${f}`).toString("base64")]),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_FIXTURES: fixtures,
            // Random per run so no secret-shaped literal lives in the repo (gitleaks).
            BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
            EMAIL_PROVIDER: "outbox",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
