/** Bindings `packages/storage` needs; a Worker's Env must include these. */
export interface StorageEnv {
  DB: D1Database;
  FILES: R2Bucket;
  KV: KVNamespace;
}
