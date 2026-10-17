// The slice of node:async_hooks this package uses. Workers provide it under
// nodejs_compat (wrangler.jsonc); @cloudflare/workers-types does not declare it.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
