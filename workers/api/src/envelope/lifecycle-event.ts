// What the Envelope DO and its EnvelopeLifecycle Workflow (lifecycle.ts) share.

/** The Workflow event the DO sends once every signer has signed. */
export const ALL_SIGNED = "all-signed";

/** Pending signers are reminded this often (ADR-0006). */
export const REMIND_EVERY_MS = 3 * 24 * 60 * 60 * 1000;

/** An EnvelopeLifecycle instance's params; its id is the Envelope id. */
export interface LifecycleParams {
  readonly tenantId: string;
  readonly envelopeId: string;
  /** Where links in reminder and completion emails point: the public app origin. */
  readonly origin: string;
}
