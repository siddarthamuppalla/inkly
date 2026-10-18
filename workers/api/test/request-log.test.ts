import { afterEach, describe, expect, it, vi } from "vitest";

import app from "../src/index.ts";
import { hooks, ORIGIN } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function requestLines(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([text]) => (typeof text === "string" && text.startsWith("{") ? JSON.parse(text) : null))
    .filter((l: { event?: string } | null) => l?.event?.startsWith("request_"));
}

describe("request log (#72)", () => {
  it("logs a start and an end with the same id, and returns that id as a header", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await app.request(`${ORIGIN}/api/documents`, {}, hooks);
    expect(res.status).toBe(401);
    const [start, end] = requestLines(spy);
    expect(start).toMatchObject({ event: "request_start", method: "GET", path: "/api/documents" });
    expect(end).toMatchObject({ event: "request_end", status: 401, requestId: start.requestId });
    expect(typeof end.ms).toBe("number");
    expect(res.headers.get("x-inkly-request-id")).toBe(start.requestId);
  });

  it("never logs a Share-link token or a query string", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await app.request(`${ORIGIN}/api/share/secret-token-value/content?x=1`, {}, hooks);
    const logged = spy.mock.calls.map(([t]) => String(t)).join("\n");
    expect(logged).not.toContain("secret-token-value");
    expect(requestLines(spy)[0]).toMatchObject({ path: "/api/share/:token/content" });
  });
});
