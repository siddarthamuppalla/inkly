import { env } from "cloudflare:workers";

/** Raw D1 rows, for tests that assert what is (and is not) stored. */
export async function rows<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
}

function delayed(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A statement whose results arrive `ms` late. */
function slowStatement(statement: D1PreparedStatement, ms: number): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === "bind") {
        return (...args: unknown[]) =>
          slowStatement(fn.apply(target, args) as D1PreparedStatement, ms);
      }
      if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
        return async (...args: unknown[]) => {
          await delayed(ms);
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  });
}

/**
 * Makes every query and batch on env.DB answer `ms` late, as remote D1 is slower than
 * local D1, for every request the Worker serves until the returned function restores it.
 */
export function slowDownD1(ms: number): () => void {
  const real = env.DB;
  const slow = new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await delayed(ms);
          return target.batch(statements);
        };
      }
      if (prop === "prepare") return (sql: string) => slowStatement(target.prepare(sql), ms);
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? (value as () => unknown).bind(target) : value;
    },
  });
  (env as { DB: D1Database }).DB = slow;
  return () => {
    (env as { DB: D1Database }).DB = real;
  };
}
