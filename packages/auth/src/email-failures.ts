import { AsyncLocalStorage } from "node:async_hooks";

import { logEvent } from "@inkly/domain/log";

// Better-Auth runs the email callbacks inside a try/catch that only logs, so a refused
// send still answers `{ success: true }`. The auth handler opens a scope per request;
// a failed send marks it, and the handler turns that into an `email_failed` error.

const scope = new AsyncLocalStorage<{ failed: boolean }>();

export async function withEmailFailures<T>(
  run: () => Promise<T>,
): Promise<{ result: T; failed: boolean }> {
  const state = { failed: false };
  const result = await scope.run(state, run);
  return { result, failed: state.failed };
}

/** Runs a send, recording a failure in the current request's scope before rethrowing it. */
export async function reportingEmailFailure<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (err) {
    const state = scope.getStore();
    if (state) state.failed = true;
    const entry = {
      event: "email_failed",
      message: err instanceof Error ? err.message : String(err),
    };
    logEvent(entry);
    throw err;
  }
}
