import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
} from "kysely";

// The Kysely dialect Better-Auth runs its queries through (#72).
//
// Better-Auth's built-in D1 dialect reuses Kysely's SqliteAdapter, which says SQLite has
// one connection, so Kysely puts every query of the Better-Auth instance behind one
// mutex: a query takes the lock and gives it back when it returns. getAuth shares that
// instance across the isolate's requests. On Cloudflare a client disconnect cancels a
// request with its I/O, so a query that held the lock never returns and the lock is
// never given back: every later auth query in the isolate waits on it, with no error.
//
// D1 has no connection to share: each statement is its own request to the database,
// and interactive transactions are not supported. So this dialect says it supports
// multiple connections, and Kysely does not serialize its queries.

class D1Adapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true;
  }
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly db: D1Database) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.db
      .prepare(compiled.sql)
      .bind(...compiled.parameters)
      .all<R>();
    const { changes, last_row_id: lastRowId } = result.meta;
    return {
      rows: result.results,
      ...(typeof changes === "number" && { numAffectedRows: BigInt(changes) }),
      ...(typeof lastRowId === "number" && { insertId: BigInt(lastRowId) }),
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming queries");
  }
}

function noTransactions(): Promise<never> {
  return Promise.reject(new Error("D1 does not support interactive transactions; use batch()"));
}

class D1Driver implements Driver {
  readonly #connection: D1Connection;

  constructor(db: D1Database) {
    this.#connection = new D1Connection(db);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.#connection);
  }
  beginTransaction = noTransactions;
  commitTransaction = noTransactions;
  rollbackTransaction = noTransactions;
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export class D1Dialect implements Dialect {
  constructor(private readonly db: D1Database) {}

  createAdapter(): DialectAdapter {
    return new D1Adapter();
  }
  createDriver(): Driver {
    return new D1Driver(this.db);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
