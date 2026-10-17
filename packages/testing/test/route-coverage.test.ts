import { describe, expect, it } from "vitest";

import { routeCoverage, type SeenRequest } from "../src/app/route-coverage.ts";

const routes = [
  { method: "GET", path: "/api/documents" },
  { method: "GET", path: "/api/documents/:id" },
  { method: "POST", path: "/api/documents/:id/versions/:n/restore" },
  { method: "POST", path: "/api/auth/*" },
  { method: "DELETE", path: "/api/folders/:id" },
];

const seen = (entries: Record<string, SeenRequest[]>) => new Map(Object.entries(entries));

describe("routeCoverage", () => {
  it("counts successful requests per route and names the journeys that made them", () => {
    const result = routeCoverage(
      routes,
      seen({
        "J-003": [
          { method: "GET", path: "/api/documents", status: 200 },
          { method: "GET", path: "/api/documents/doc_1", status: 200 },
          { method: "POST", path: "/api/auth/email-otp/send-verification-otp", status: 200 },
        ],
        "J-005": [
          { method: "GET", path: "/api/documents/", status: 200 },
          { method: "POST", path: "/api/documents/doc_1/versions/1/restore", status: 201 },
        ],
      }),
    );
    expect(result.map((r) => [r.route.path, r.hits, r.journeys])).toEqual([
      ["/api/documents", 2, ["J-003", "J-005"]],
      ["/api/documents/:id", 1, ["J-003"]],
      ["/api/documents/:id/versions/:n/restore", 1, ["J-005"]],
      ["/api/auth/*", 1, ["J-003"]],
      ["/api/folders/:id", 0, []],
    ]);
  });

  it("does not count 4xx or 5xx responses, or another method on the same path", () => {
    const result = routeCoverage(
      routes,
      seen({
        "J-004": [
          { method: "DELETE", path: "/api/folders/fld_1", status: 404 },
          { method: "DELETE", path: "/api/folders/fld_1", status: 500 },
          { method: "GET", path: "/api/folders/fld_1", status: 200 },
        ],
      }),
    );
    expect(result.find((r) => r.route.path === "/api/folders/:id")?.hits).toBe(0);
  });

  it("does not let a param match more than one path segment", () => {
    const result = routeCoverage(
      routes,
      seen({ "J-006": [{ method: "GET", path: "/api/documents/doc_1/versions", status: 200 }] }),
    );
    expect(result.find((r) => r.route.path === "/api/documents/:id")?.hits).toBe(0);
  });
});
