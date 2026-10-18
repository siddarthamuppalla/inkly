import { describe, expect, it } from "vitest";

import { workerErrors } from "../src/app/local-server.ts";

describe("workerErrors", () => {
  it("pulls unhandled_error stacks and wrangler errors out of wrangler dev output", () => {
    const event = JSON.stringify({
      event: "unhandled_error",
      message: "boom",
      stack: "Error: boom\n    at receivePdf (upload.ts:70:5)",
    });
    const log = [
      `{"event":"request_start","requestId":"r1","method":"POST","path":"/api/documents"}\n`,
      `${event}\n[wrangler:info] POST /api/documents 500 Internal Server Error (12ms)\n`,
      "✘ [ERROR] Uncaught TypeError: x is not a function\n",
    ];
    expect(workerErrors(log)).toEqual([
      "unhandled_error: Error: boom\n    at receivePdf (upload.ts:70:5)",
      "✘ [ERROR] Uncaught TypeError: x is not a function",
    ]);
  });

  it("is empty for a clean run", () => {
    expect(
      workerErrors(["⎔ Starting local server...\n", "[wrangler:info] GET /health 200 OK\n"]),
    ).toEqual([]);
  });
});
