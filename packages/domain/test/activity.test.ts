import { describe, expect, it } from "vitest";

import { activityAction } from "../src/index.ts";

describe("activityAction", () => {
  it("names each kind of access-log entry", () => {
    const cases = [
      [{ action: "read-content", status: 200 }, "viewed"],
      [{ action: "read", status: 200 }, "viewed"],
      [{ action: "download", status: 200 }, "downloaded"],
      [{ action: "unlock", status: 200 }, "unlocked"],
      [{ action: "write", status: 200 }, "edited"],
      [{ action: "unlock", status: 401 }, "denied"],
      [{ action: "unlock", status: 429 }, "denied"],
      [{ action: "write", status: 403 }, "denied"],
      [{ action: "read", status: 404 }, "denied"],
    ] as const;
    for (const [entry, expected] of cases)
      expect([entry, activityAction(entry)]).toEqual([entry, expected]);
  });
});
