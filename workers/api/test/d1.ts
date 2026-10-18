import { env } from "cloudflare:workers";

/** Raw D1 rows, for tests that assert what is (and is not) stored. */
export async function rows<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
}

/** Runs one UPDATE on audit_events with its append-only trigger lifted, as an attacker with D1 access could. */
export async function tamperAuditEvents(sql: string, ...binds: unknown[]): Promise<void> {
  await env.DB.prepare("DROP TRIGGER audit_events_no_update").run();
  try {
    await env.DB.prepare(sql)
      .bind(...binds)
      .run();
  } finally {
    await env.DB.prepare(
      "CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END",
    ).run();
  }
}
