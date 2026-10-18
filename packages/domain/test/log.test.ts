import { afterEach, describe, expect, it, vi } from "vitest";

import { step, type StepLog } from "../src/log.ts";

function stepLines(spy: { mock: { calls: unknown[][] } }): StepLog[] {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as StepLog);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("step", () => {
  it("logs a start before the step and an end with its duration after", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await step("rate_limit", () => Promise.resolve(7))).toBe(7);
    const [start, end] = stepLines(spy);
    expect(start).toEqual({ event: "step_start", step: "rate_limit" });
    expect(end).toMatchObject({ event: "step_end", step: "rate_limit" });
    expect(typeof end?.ms).toBe("number");
  });

  it("logs step_error and rethrows when the step fails", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(step("email_send", () => Promise.reject(new Error("refused")))).rejects.toThrow(
      "refused",
    );
    expect(stepLines(spy).map((l) => l.event)).toEqual(["step_start", "step_error"]);
  });

  it("leaves only a start for a step that never settles", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    void step("auth_handler", () => new Promise<never>(() => undefined));
    await Promise.resolve();
    expect(stepLines(spy)).toEqual([{ event: "step_start", step: "auth_handler" }]);
  });
});
