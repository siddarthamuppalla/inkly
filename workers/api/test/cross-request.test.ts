import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { slowDownD1 } from "./d1.ts";

// #72: on Cloudflare one isolate serves many requests at once, and a client that
// disconnects cancels its request along with the I/O it started. If another request
// awaits a promise whose I/O belonged to the cancelled one, it never gets a response:
// no error, no timeout, just a hang (what the preview journeys hit).
//
// Requests here go through exports.default.fetch, so each runs in its own request
// context (app.request would run in the test's). Aborting the call cancels that request,
// as a client disconnect does on Cloudflare. D1 is slowed, as remote D1 is slower than
// local D1, so the first request is cancelled while its D1 work is in flight.

const GET_SESSION = "/api/auth/get-session";
const SLOW_MS = 300;

async function cancelledAfter(url: string, ms: number): Promise<void> {
  const controller = new AbortController();
  const pending = exports.default.fetch(url, { signal: controller.signal }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, ms));
  controller.abort();
  const res = await pending;
  await res?.body?.cancel();
}

async function statusWithin(
  url: string,
  ms: number,
  init: RequestInit = {},
): Promise<number | "no response"> {
  const timeout = new Promise<"no response">((resolve) =>
    setTimeout(() => {
      resolve("no response");
    }, ms),
  );
  const status = exports.default.fetch(url, init).then(async (res) => {
    await res.body?.cancel();
    return res.status;
  });
  return Promise.race([status, timeout]);
}

let restoreD1 = (): void => undefined;

afterEach(() => {
  restoreD1();
});

describe("an auth request its client cancels (#72)", () => {
  it("does not leave later requests in the isolate without a response, reads or writes", async () => {
    restoreD1 = slowDownD1(SLOW_MS);
    // A new origin, so this is the first auth request the isolate serves for it.
    const origin = "http://cancelled-first.inkly.test";
    await cancelledAfter(`${origin}${GET_SESSION}`, 50);
    // Every API route authenticates through Better-Auth, so reads and writes both stall.
    const budget = 10 * SLOW_MS + 2000;
    const statuses = await Promise.all([
      statusWithin(`${origin}${GET_SESSION}`, budget),
      statusWithin(`${origin}/api/documents`, budget),
      statusWithin(`${origin}/api/tenant/members/usr_someone`, budget, { method: "DELETE" }),
      statusWithin(`${origin}/api/folders`, budget, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x" }),
      }),
    ]);
    expect(statuses).toEqual([200, 401, 401, 401]);
  }, 30_000);
});
