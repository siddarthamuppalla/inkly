import type { DocumentId, TenantId } from "@inkly/domain";
import { describe, expect, it } from "vitest";
import { versionKey } from "../src/keys.ts";

const tenant = "t_a" as TenantId;
const doc = "d_1" as DocumentId;

describe("versionKey", () => {
  it("builds t/{tenantId}/d/{documentId}/v{n}", () => {
    expect(versionKey(tenant, doc, 3)).toBe("t/t_a/d/d_1/v3");
  });

  it("rejects ids that could escape the tenant prefix", () => {
    expect(() => versionKey("../t_b" as TenantId, doc, 1)).toThrow(RangeError);
    expect(() => versionKey(tenant, "x/../../t_b" as DocumentId, 1)).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects version %s", (n) => {
    expect(() => versionKey(tenant, doc, n)).toThrow(RangeError);
  });
});
