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
const SEND_CODE = "/api/auth/email-otp/send-verification-otp";
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
    // A deployed Worker evaluates its whole bundle before it serves a request (wrangler
    // inlines Better-Auth's dynamic imports). Under vitest those imports are fetched from
    // the module server on first use, inside whichever request gets there first, so
    // cancelling that request would strand Better-Auth's init for a test-only reason.
    // One uncancelled auth request on another origin loads them first.
    expect(await statusWithin(`http://warm-up.inkly.test${GET_SESSION}`, 20_000)).toBe(200);
    restoreD1 = slowDownD1(SLOW_MS);
    // A new origin, so this is the first auth request the isolate serves for it.
    const origin = "http://cancelled-first.inkly.test";
    await cancelledAfter(`${origin}${GET_SESSION}`, 50);
    // Every API route authenticates through Better-Auth, so reads and writes both stall.
    // A hung request never answers, so a wide budget only absorbs a loaded test run.
    const budget = 20_000;
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
  }, 60_000);

  it("does not hold Better-Auth's D1 queue for later requests when cancelled mid-query", async () => {
    // Kysely runs SQLite dialects, D1's included, through one connection mutex per
    // Better-Auth instance: each query takes the lock and releases it when it returns.
    // Cancel a request while its query holds the lock and the release never runs, so
    // every later auth query in the isolate waits for it (the hung OTP send on preview).
    expect(await statusWithin(`http://warm-up-2.inkly.test${GET_SESSION}`, 20_000)).toBe(200);
    restoreD1 = slowDownD1(SLOW_MS);
    const origin = "http://cancelled-mid-query.inkly.test";
    const send = (email: string, signal?: AbortSignal): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, type: "sign-in" }),
      ...(signal && { signal }),
    });
    // The send stores the code (one query), then looks the User up (a second): cancel it
    // halfway through the second, while that query holds the lock.
    const controller = new AbortController();
    const first = exports.default
      .fetch(`${origin}${SEND_CODE}`, send("first@example.com", controller.signal))
      .catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS * 1.5));
    controller.abort();
    await (await first)?.body?.cancel();
    const budget = 20_000;
    const statuses = await Promise.all([
      statusWithin(`${origin}${SEND_CODE}`, budget, send("second@example.com")),
      statusWithin(`${origin}/api/documents`, budget, {
        headers: { authorization: "Bearer not-a-session" },
      }),
    ]);
    expect(statuses).toEqual([200, 401]);
  }, 60_000);
});
