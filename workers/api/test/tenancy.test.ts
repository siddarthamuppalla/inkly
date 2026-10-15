import type { DocumentId, TenantId } from "@inkly/domain";
import { createTenant, getTenant, getVersionBytes, putVersionBytes } from "@inkly/storage";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const doc = "d_1" as DocumentId;

function freshTenants(): [TenantId, TenantId] {
  const run = crypto.randomUUID().slice(0, 8);
  return [`t_a_${run}` as TenantId, `t_b_${run}` as TenantId];
}

describe("tenant isolation in packages/storage (ADR-0004)", () => {
  it("defaults a new tenant to the free plan in the default region", async () => {
    const [tenantA] = freshTenants();
    await createTenant(tenantA, env, "Acme");
    expect(await getTenant(tenantA, env)).toMatchObject({
      id: tenantA,
      name: "Acme",
      plan: "free",
      region: "default",
    });
  });

  it("does not return tenant A's row when reading as tenant B", async () => {
    const [tenantA, tenantB] = freshTenants();
    await createTenant(tenantA, env, "Acme");
    expect(await getTenant(tenantB, env)).toBeNull();
  });

  it("does not return tenant A's file when reading the same document id as tenant B", async () => {
    const [tenantA, tenantB] = freshTenants();
    const bytes = new TextEncoder().encode("%PDF-1.7 tenant A");
    await putVersionBytes(tenantA, env, doc, 1, bytes);

    const asA = await getVersionBytes(tenantA, env, doc, 1);
    expect(asA && new TextDecoder().decode(asA)).toBe("%PDF-1.7 tenant A");
    expect(await getVersionBytes(tenantB, env, doc, 1)).toBeNull();
  });
});
