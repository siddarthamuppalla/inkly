// lint-fixture target: packages/storage/src/__lint_fixture__storage_uses_d1.ts
// lint-fixture expect: none
interface D1Database {
  prepare(sql: string): unknown;
}
export function query(env: { DB: D1Database }): unknown {
  return env.DB.prepare("SELECT 1");
}
