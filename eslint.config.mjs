import { builtinModules } from "node:module";
import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import globals from "globals";
import tseslint from "typescript-eslint";
import noDirectBindings from "./tools/eslint-rules/no-direct-bindings.mjs";
import noRawColors from "./tools/eslint-rules/no-raw-colors.mjs";
import noTenantIdMint from "./tools/eslint-rules/no-tenant-id-mint.mjs";

const inkly = {
  rules: {
    "no-direct-bindings": noDirectBindings,
    "no-raw-colors": noRawColors,
    "no-tenant-id-mint": noTenantIdMint,
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.turbo/**",
      "**/.wrangler/**",
      "apps/web/build/**",
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
      // packages/domain imports nothing with I/O; packages/pdf has no I/O either.
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
              from: { element: { type: "pdf" } },
              disallow: { to: { element: { types: { anyOf: ["storage", "auth"] } } } },
            },
            {
              from: { element: { type: "!worker" } },
              disallow: { to: { element: { type: "worker" } } },
            },
          ],
        },
      ],
      "inkly/no-direct-bindings": "error",
      "inkly/no-tenant-id-mint": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@inkly/storage/auth",
              message:
                "Only packages/auth may use @inkly/storage/auth (auth tables, Outbox, KV counters). Call a packages/auth function instead.",
            },
          ],
        },
      ],
    },
  },
  {
    // ADR-0004: packages/auth is where TenantIds are minted and auth storage is used.
    files: ["packages/auth/**/*.ts", "packages/storage/**/*.ts"],
    rules: { "inkly/no-tenant-id-mint": "off", "no-restricted-imports": "off" },
  },
  {
    // Tests build fake TenantIds to exercise storage directly.
    files: ["**/test/**/*.ts"],
    rules: { "inkly/no-tenant-id-mint": "off" },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { inkly },
    rules: { "inkly/no-raw-colors": "error" },
  },
  {
    // packages/pdf runs inside Workers: no Node built-ins (CLAUDE.md paved roads).
    files: ["packages/pdf/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules.map((name) => ({
            name,
            message: "packages/pdf runs in Workers; Node built-ins are unavailable.",
          })),
          patterns: [{ group: ["node:*"], message: "packages/pdf runs in Workers; use Web APIs." }],
        },
      ],
      "no-restricted-globals": ["error", "Buffer", "process", "require", "__dirname"],
    },
  },
  {
    files: ["packages/storage/**/*.ts"],
    rules: { "inkly/no-direct-bindings": "off" },
  },
  {
    // Test-runtime bootstrap (applies D1 migrations) and raw-row assertions on the schema.
    files: ["workers/*/test/apply-migrations.ts", "workers/*/test/d1.ts"],
    rules: { "inkly/no-direct-bindings": "off" },
  },
);
