import { describe, expect, it } from "vitest";

import { AppError, isAppError } from "../src/index.ts";

describe("AppError", () => {
  it("carries a stable code and the HTTP status for it", () => {
    const err = new AppError("limit_exceeded", "Free plan allows 1 member");
    expect(err).toMatchObject({ code: "limit_exceeded", status: 402 });
    expect(err.toJSON()).toEqual({ error: "limit_exceeded", message: "Free plan allows 1 member" });
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });

  it("lets a caller override the status, e.g. 413 for an oversized upload", () => {
    expect(new AppError("limit_exceeded", "too big", 413).status).toBe(413);
  });
});
