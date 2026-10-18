import { tenantOfLifecycle } from "@inkly/auth";
import type { EnvelopeId, EnvelopeStatus } from "@inkly/domain";
import { getEnvelope } from "@inkly/storage";
import { NonRetryableError } from "cloudflare:workflows";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";

import type { Env } from "../env.ts";
import { envelopeObject, type EnvelopeOutcome, type EnvelopeRef } from "./do.ts";
import { ALL_SIGNED, REMIND_EVERY_MS, type LifecycleParams } from "./lifecycle-event.ts";

// EnvelopeLifecycle (ADR-0006): one instance per sent Envelope, id = Envelope id. It owns time
// and retries: each round it reads the Envelope, waits for "all-signed" until the next reminder
// or expiry, then reminds, expires or finalizes. It only calls Envelope DO methods, each
// idempotent on the Envelope's status, so a retried step or a stale round converges. It ends
// once the Envelope is completed, declined, voided or expired.

/** Finalize retries until the seal key and storage cooperate: about 17 hours of backoff. */
const FINALIZE: WorkflowStepConfig = {
  retries: { limit: 10, delay: "1 minute", backoff: "exponential" },
  timeout: "10 minutes",
};

type Stub = ReturnType<typeof envelopeObject>;

export class EnvelopeLifecycle extends WorkflowEntrypoint<Env, LifecycleParams> {
  override async run(
    event: Readonly<WorkflowEvent<LifecycleParams>>,
    step: WorkflowStep,
  ): Promise<EnvelopeStatus> {
    const { origin } = event.payload;
    const tenantId = tenantOfLifecycle(event.payload.tenantId);
    if (!tenantId) throw new NonRetryableError("lifecycle params carry no tenant");
    const ref: EnvelopeRef = { tenantId, envelopeId: event.payload.envelopeId as EnvelopeId };
    const finalize = () =>
      step.do("finalize", FINALIZE, () => this.call(ref, (o) => o.finalize(ref, origin)));

    for (let round = 1; ; round++) {
      const state = await step.do("read envelope", () =>
        this.call(ref, (o) => o.lifecycleState(ref)),
      );
      if (state.status === "completing") {
        await finalize();
        return "completed";
      }
      if (state.status !== "sent") return state.status;

      const expiresAt = state.expiresAt ?? state.at + REMIND_EVERY_MS;
      const due = Math.min(state.at + REMIND_EVERY_MS, expiresAt);
      const signed = await step
        .waitForEvent("wait for signatures", {
          type: ALL_SIGNED,
          timeout: Math.max(due - state.at, 1000),
        })
        .then(
          () => true,
          () => false,
        );
      if (signed) {
        await finalize();
        return "completed";
      }
      if (due >= expiresAt) {
        await step.do("expire", () => this.call(ref, (o) => o.expire(ref)));
      } else {
        await step.do("remind", () => this.call(ref, (o) => o.remindPending(ref, round, origin)));
      }
    }
  }

  /** Runs one DO method; a refusal throws, so the step retries. */
  private async call<T>(ref: EnvelopeRef, run: (o: Stub) => Promise<EnvelopeOutcome<T>>) {
    const envelope = await getEnvelope(ref.tenantId, this.env, ref.envelopeId);
    if (!envelope) throw new Error(`envelope ${ref.envelopeId} is gone`);
    const outcome = await run(envelopeObject(this.env, ref.tenantId, envelope));
    if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
    return outcome.value;
  }
}
