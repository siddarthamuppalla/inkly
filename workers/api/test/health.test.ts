import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("round-trips D1, R2 and KV", async () => {
    const response = await exports.default.fetch("http://inkly.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, d1: true, r2: true, kv: true });
  });
});
