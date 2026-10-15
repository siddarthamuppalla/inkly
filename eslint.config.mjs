import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";
import noDirectBindings from "./tools/eslint-rules/no-direct-bindings.mjs";

const inkly = { rules: { "no-direct-bindings": noDirectBindings } };

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.wrangler/**",
      "tools/lint-fixtures/cases/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["apps/**/*.{ts,tsx}", "workers/**/*.ts", "packages/**/*.ts"],
    plugins: { boundaries, inkly },
    settings: {
      "boundaries/elements": [
        { type: "web", pattern: "apps/web" },
        { type: "worker", pattern: "workers/*" },
        { type: "domain", pattern: "packages/domain" },
        { type: "storage", pattern: "packages/storage" },
        { type: "auth", pattern: "packages/auth" },
        { type: "pdf", pattern: "packages/pdf" },
        { type: "testing", pattern: "packages/testing" },
      ],
    },
    rules: {
      // CLAUDE.md "Boundaries": apps/web never reaches workers or storage;
      // packages/domain imports nothing with I/O.
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              from: { element: { type: "web" } },
              disallow: { to: { element: { types: { anyOf: ["worker", "storage"] } } } },
            },
            {
              from: { element: { type: "domain" } },
              disallow: { to: { element: { type: "!domain" } } },
            },
            {
              from: { element: { type: "!worker" } },
              disallow: { to: { element: { type: "worker" } } },
            },
          ],
        },
      ],
      "inkly/no-direct-bindings": "error",
    },
  },
  {
    files: ["packages/storage/**/*.ts"],
    rules: { "inkly/no-direct-bindings": "off" },
  },
  {
    // Test-runtime bootstrap: applies D1 migrations before any test, outside any tenant.
    files: ["workers/*/test/apply-migrations.ts"],
    rules: { "inkly/no-direct-bindings": "off" },
  },
);
