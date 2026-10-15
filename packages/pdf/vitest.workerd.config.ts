import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-10-01" } })],
  test: { include: ["test/workerd/**/*.test.ts"] },
});
