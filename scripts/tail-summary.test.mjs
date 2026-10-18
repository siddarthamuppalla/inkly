// node --test scripts/tail-summary.test.mjs
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConcatenated, summarize } from "./tail-summary.mjs";

const line = (o) => JSON.stringify(o);
const event = (outcome, method, path, logs) => ({
  outcome,
  eventTimestamp: 1_792_320_000_000,
  event: { request: { method, url: `https://inkly-pr-1.example.workers.dev${path}` } },
  logs: logs.map((l) => ({ message: [line(l)], level: "log" })),
  exceptions: [],
});

describe("tail-summary", () => {
  it("finds a request that started but never answered, pretty-printed or not", () => {
    const answered = event("ok", "GET", "/api/me", [
      { event: "request_start", requestId: "a", method: "GET", path: "/api/me" },
      { event: "request_end", requestId: "a", method: "GET", path: "/api/me", status: 200, ms: 3 },
    ]);
    const hung = event("canceled", "GET", "/api/documents/doc_1", [
      { event: "request_start", requestId: "b", method: "GET", path: "/api/documents/doc_1" },
    ]);
    const text = `${JSON.stringify(answered, null, 2)}\n${line(hung)}\n{"truncated":`;
    const s = summarize(parseConcatenated(text));
    assert.equal(s.events, 2);
    assert.deepEqual(s.outcomes, { ok: 1, canceled: 1 });
    assert.equal(s.unanswered.length, 1);
    assert.match(s.unanswered[0], /GET \/api\/documents\/doc_1 id=b outcome=canceled/);
    assert.equal(s.notOk.length, 1);
  });
});
