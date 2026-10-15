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
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, TEST_FIXTURES: fixtures } },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
