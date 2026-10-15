// lint-fixture target: workers/api/src/__lint_fixture__d1_outside_storage.ts
// lint-fixture expect: inkly/no-direct-bindings
interface D1Database {
  prepare(sql: string): unknown;
}
export function leak(env: { DB: D1Database }): unknown {
  return env.DB.prepare("SELECT 1");
}
