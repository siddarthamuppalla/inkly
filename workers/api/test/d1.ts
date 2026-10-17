import { env } from "cloudflare:workers";

/** Raw D1 rows, for tests that assert what is (and is not) stored. */
export async function rows<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
}
