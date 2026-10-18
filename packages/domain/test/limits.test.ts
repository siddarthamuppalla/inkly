import { describe, expect, it } from "vitest";

import { AppError, assertUploadAllowed, MiB, PLAN_LIMITS } from "../src/index.ts";

function refusal(fn: () => void): { code: string; status: number } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return { code: err.code, status: err.status };
    throw err;
  }
}

describe("plan limits (Q8)", () => {
  it("gives Free 25 MiB per file, 500 MiB of storage and 3 envelopes; Pro 100 MiB, 20 GiB and 50", () => {
    expect(PLAN_LIMITS.free).toEqual({
      fileBytes: 25 * MiB,
      storageBytes: 500 * MiB,
      pageOps: 50,
      envelopes: 3,
    });
    expect(PLAN_LIMITS.pro).toEqual({
      fileBytes: 100 * MiB,
      storageBytes: 20 * 1024 * MiB,
      pageOps: 2000,
      envelopes: 50,
    });
  });

  it("refuses a 26 MiB file on Free with 413 limit_exceeded and allows it on Pro", () => {
    const upload = { fileBytes: 26 * MiB, storageBytes: 0 };
    expect(
      refusal(() => {
        assertUploadAllowed("free", upload);
      }),
    ).toEqual({
      code: "limit_exceeded",
      status: 413,
    });
    expect(
      refusal(() => {
        assertUploadAllowed("pro", upload);
      }),
    ).toBeNull();
  });

  it("allows a file of exactly the per-file limit", () => {
    expect(
      refusal(() => {
        assertUploadAllowed("free", { fileBytes: 25 * MiB, storageBytes: 0 });
      }),
    ).toBeNull();
  });

  it("refuses an upload that would take Free storage over 500 MiB with 402 limit_exceeded", () => {
    const used = 500 * MiB - 1000;
    expect(
      refusal(() => {
        assertUploadAllowed("free", { fileBytes: 1000, storageBytes: used });
      }),
    ).toBeNull();
    expect(
      refusal(() => {
        assertUploadAllowed("free", { fileBytes: 1001, storageBytes: used });
      }),
    ).toEqual({ code: "limit_exceeded", status: 402 });
  });
});
