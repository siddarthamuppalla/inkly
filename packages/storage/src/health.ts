import type { StorageEnv } from "./env.ts";

export interface BindingHealth {
  d1: boolean;
  r2: boolean;
  kv: boolean;
}

const PROBE_KEY = "__health__/probe";

async function probe(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

/**
 * Round-trips each binding on a reserved, non-tenant key. Lives on its own entry point
 * (`@inkly/storage/health`) so the main storage API stays TenantId-first.
 */
export async function probeBindings(env: StorageEnv): Promise<BindingHealth> {
  const stamp = crypto.randomUUID();
  const [d1, r2, kv] = await Promise.all([
    probe(async () => {
      const row = await env.DB.prepare("SELECT ?1 AS v").bind(stamp).first<{ v: string }>();
      return row?.v === stamp;
    }),
    probe(async () => {
      await env.FILES.put(PROBE_KEY, stamp);
      const object = await env.FILES.get(PROBE_KEY);
      return (await object?.text()) === stamp;
    }),
    probe(async () => {
      await env.KV.put(PROBE_KEY, stamp, { expirationTtl: 60 });
      return (await env.KV.get(PROBE_KEY)) === stamp;
    }),
  ]);
  return { d1, r2, kv };
}
