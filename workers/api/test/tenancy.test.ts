import type { DocumentId, TenantId, UserId } from "@inkly/domain";
import {
  createDocument,
  createTenant,
  getDocument,
  getTenant,
  listTenantObjectKeys,
  openVersion,
} from "@inkly/storage";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { sha256 } from "./helpers.ts";

const doc = "d_1" as DocumentId;
const user = "u_1" as UserId;

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

  it("does not return tenant A's Document or bytes when reading the same id as tenant B", async () => {
    const [tenantA, tenantB] = freshTenants();
    await createTenant(tenantA, env, "A");
    await createTenant(tenantB, env, "B");
    const body = new TextEncoder().encode("%PDF-1.7 tenant A");
    await createDocument(
      tenantA,
      env,
      { id: doc, title: "A", folderId: null },
      { body, sha256: await sha256(body), pages: 1, createdBy: user },
    );

    const asA = await openVersion(tenantA, env, doc);
    expect(asA && (await new Response(asA.object.body).text())).toBe("%PDF-1.7 tenant A");
    expect(await openVersion(tenantB, env, doc)).toBeNull();
    expect(await openVersion(tenantB, env, doc, 1)).toBeNull();
    expect(await getDocument(tenantB, env, doc)).toBeNull();
    expect(await listTenantObjectKeys(tenantB, env)).toEqual([]);
  });
});
