import { z } from "zod";

import type { FieldKind, OrderMode, RecipientInfo } from "./envelopes.ts";

// The signer side of an Envelope (T3.3, ADR-0006): what `/api/sign/:token` takes and returns,
// and the checks a Field value must pass. Shared by the Envelope DO and the `/sign` page.

const MINUTE_MS = 60 * 1000;

/** Signing codes: 6 digits, 10 minutes, 5 sends per Recipient per 10 minutes, 5 tries each. */
export const SIGNING_CODE = {
  ttlMs: 10 * MINUTE_MS,
  maxSends: 5,
  sendWindowMs: 10 * MINUTE_MS,
  maxAttempts: 5,
} as const;

/** How long a right code lets this browser view and sign. */
export const SIGNER_GRANT_TTL_MS = 60 * MINUTE_MS;

/** Largest signature or initials image, decoded. */
export const SIGNATURE_IMAGE_MAX_BYTES = 200 * 1024;
export const TEXT_FIELD_MAX = 500;

/** The electronic-records consent the signer ticks; the `signed` audit event carries it word for word. */
export const CONSENT_TEXT =
  "I agree to use electronic records and signatures for this document. I understand that my electronic signature is as legally binding as my handwritten one, and that I can ask the sender for a paper copy.";

export const SignerCode = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from the email"),
});

const FieldIdText = z.string().regex(/^fld_[A-Za-z0-9]{1,60}$/, "Field ids start with fld_");

export const SignerSign = z.object({
  /** Field id → value, for this signer's Fields. Dates are filled in by the server. */
  values: z.record(FieldIdText, z.string().max(300_000)),
  consent: z.literal(true, "Tick the box to agree to sign electronically"),
});
export type SignerSign = z.infer<typeof SignerSign>;

export const SignerDecline = z.object({
  reason: z.string().trim().min(1, "Say why you are declining").max(500),
});

export const SignerField = z.object({
  id: z.string(),
  kind: z.enum(["signature", "initials", "date", "text", "checkbox"]),
  page: z.number().int(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  required: z.boolean(),
});
export type SignerField = z.infer<typeof SignerField>;

/** `GET /api/sign/:token`: a done state, or the Envelope waiting for this signer. */
export const SignerEnvelope = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("signed"),
    title: z.string(),
    /** True once the Envelope is completed and the sealed PDF can be downloaded. */
    signedAvailable: z.boolean(),
  }),
  z.object({
    status: z.literal("pending"),
    title: z.string(),
    message: z.string(),
    sender: z.object({ name: z.string(), email: z.string() }),
    recipient: z.object({ name: z.string() }),
    /** True while this browser holds a signer grant: `fields` and `pages` are then filled in. */
    verified: z.boolean(),
    pages: z.number().int().nullable(),
    fields: z.array(SignerField),
  }),
]);
export type SignerEnvelope = z.infer<typeof SignerEnvelope>;

export const SignerDone = z.object({
  status: z.enum(["signed", "declined"]),
});

/** The date a date Field takes: the server's signing date, `YYYY-MM-DD` in UTC. */
export function signingDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

const PNG_PREFIX = "data:image/png;base64,";
/** The PNG signature (89 50 4E 47 0D 0A 1A 0A) is always the first 11 base64 characters. */
const PNG_MAGIC_B64 = "iVBORw0KGgo";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function pngProblem(value: string, what: string): string | null {
  const b64 = value.startsWith(PNG_PREFIX) ? value.slice(PNG_PREFIX.length) : "";
  if (!BASE64.test(b64) || b64.length % 4 !== 0 || !b64.startsWith(PNG_MAGIC_B64)) {
    return `The ${what} must be a PNG image`;
  }
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const bytes = (b64.length / 4) * 3 - padding;
  if (bytes > SIGNATURE_IMAGE_MAX_BYTES) return `The ${what} image is over 200 KB`;
  return null;
}

/** Why `value` cannot fill a Field of `kind`; null when it can. Date values come from the server. */
export function fieldValueProblem(kind: FieldKind, value: string): string | null {
  switch (kind) {
    case "signature":
      return pngProblem(value, "signature");
    case "initials":
      return pngProblem(value, "initials");
    case "checkbox":
      return value === "true" || value === "false" ? null : 'A checkbox is "true" or "false"';
    case "text":
      return value.length <= TEXT_FIELD_MAX
        ? null
        : `Text fields hold up to ${String(TEXT_FIELD_MAX)} characters`;
    case "date":
      return null;
  }
}

/** Whether a Field of `kind` counts as filled in with `value` (an unticked box does not). */
export function fieldFilled(kind: FieldKind, value: string | null | undefined): boolean {
  if (kind === "date") return true;
  if (value === null || value === undefined || value.trim() === "") return false;
  return kind !== "checkbox" || value === "true";
}

type Routed = Pick<RecipientInfo, "role" | "routingOrder" | "status">;

/** True when every signer has signed (CCs never sign). */
export function everySignerSigned(recipients: readonly Routed[]): boolean {
  return recipients.filter((r) => r.role === "signer").every((r) => r.status === "signed");
}

/**
 * The signers to notify after a signature: in sequential order, the lowest routing order
 * that still has unsigned signers, once none of them has been notified yet. Parallel
 * Envelopes notify everyone at send, so nobody here.
 */
export function nextTurn<R extends Routed>(recipients: readonly R[], orderMode: OrderMode): R[] {
  if (orderMode === "parallel") return [];
  const unsigned = recipients.filter((r) => r.role === "signer" && r.status !== "signed");
  if (unsigned.length === 0) return [];
  const order = Math.min(...unsigned.map((r) => r.routingOrder));
  const turn = unsigned.filter((r) => r.routingOrder === order);
  return turn.every((r) => r.status === "waiting") ? turn : [];
}
