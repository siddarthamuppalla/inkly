import type { DocumentId, TenantId } from "@inkly/domain";
import { getTenant, getVersionBytes, putVersionBytes } from "@inkly/storage";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { seed } from "./helpers.ts";

const doc = "d_1" as DocumentId;

async function freshTenants(): Promise<[TenantId, TenantId]> {
  const [a, b] = await Promise.all([seed(), seed()]);
  return [a.tenantId as TenantId, b.tenantId as TenantId];
}

describe("tenant isolation in packages/storage (ADR-0004)", () => {
  it("defaults a new tenant to the free plan in the default region", async () => {
    const [tenantA] = await freshTenants();
    expect(await getTenant(tenantA, env)).toMatchObject({
      id: tenantA,
      plan: "free",
      region: "default",
    });
  });

  it("does not return tenant A's row when reading as tenant B", async () => {
    const [tenantA, tenantB] = await freshTenants();
    expect((await getTenant(tenantB, env))?.id).toBe(tenantB);
    expect((await getTenant(tenantB, env))?.id).not.toBe(tenantA);
    expect(await getTenant(`${tenantA}x` as TenantId, env)).toBeNull();
  });

  it("does not return tenant A's file when reading the same document id as tenant B", async () => {
    const [tenantA, tenantB] = await freshTenants();
    const bytes = new TextEncoder().encode("%PDF-1.7 tenant A");
    await putVersionBytes(tenantA, env, doc, 1, bytes);

    const asA = await getVersionBytes(tenantA, env, doc, 1);
    expect(asA && new TextDecoder().decode(asA)).toBe("%PDF-1.7 tenant A");
    expect(await getVersionBytes(tenantB, env, doc, 1)).toBeNull();
  });
});
