import type { DocumentId, TenantId, UserId } from "@inkly/domain";
import {
  createDocument,
  getDocument,
  getTenant,
  listTenantObjectKeys,
  openVersion,
} from "@inkly/storage";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { seed, sha256, type Seeded } from "./helpers.ts";

const doc = "d_1" as DocumentId;

async function freshTenants(): Promise<[Seeded, Seeded]> {
  return Promise.all([seed(), seed()]);
}

describe("tenant isolation in packages/storage (ADR-0004)", () => {
  it("defaults a new tenant to the free plan in the default region", async () => {
    const [a] = await freshTenants();
    expect(await getTenant(a.tenantId, env)).toMatchObject({
      id: a.tenantId,
      plan: "free",
      region: "default",
    });
  });

  it("does not return tenant A's row when reading as tenant B", async () => {
    const [a, b] = await freshTenants();
    expect((await getTenant(b.tenantId, env))?.id).toBe(b.tenantId);
    expect(await getTenant(`${a.tenantId}x` as TenantId, env)).toBeNull();
  });

  it("does not return tenant A's Document or bytes when reading the same id as tenant B", async () => {
    const [a, b] = await freshTenants();
    const body = new TextEncoder().encode("%PDF-1.7 tenant A");
    await createDocument(
      a.tenantId,
      env,
      { id: doc, title: "A", folderId: null },
      { body, sha256: await sha256(body), pages: 1, createdBy: a.userId as UserId },
    );

    const asA = await openVersion(a.tenantId, env, doc);
    expect(asA && (await new Response(asA.object.body).text())).toBe("%PDF-1.7 tenant A");
    expect(await openVersion(b.tenantId, env, doc)).toBeNull();
    expect(await openVersion(b.tenantId, env, doc, 1)).toBeNull();
    expect(await getDocument(b.tenantId, env, doc)).toBeNull();
    expect(await listTenantObjectKeys(b.tenantId, env)).toEqual([]);
  });
});
