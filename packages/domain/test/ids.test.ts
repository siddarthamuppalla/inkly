import { describe, expect, it } from "vitest";
import { isWellFormedId, type TenantId } from "../src/index.ts";

describe("TenantId", () => {
  it("cannot be assigned from a plain string", () => {
    // @ts-expect-error a string is not a TenantId; only packages/auth mints one
    const id: TenantId = "t_123";
    expect(id).toBe("t_123");
  });
});

describe("isWellFormedId", () => {
  it.each(["t_1", "abc-DEF_09", "x".repeat(64)])("accepts %s", (raw) => {
    expect(isWellFormedId(raw)).toBe(true);
  });

  it.each(["", "a/b", "../x", "a b", "x".repeat(65), "t_1\n"])("rejects %j", (raw) => {
    expect(isWellFormedId(raw)).toBe(false);
  });
});
