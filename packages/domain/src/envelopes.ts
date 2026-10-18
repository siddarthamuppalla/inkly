import { z } from "zod";

import { Rect } from "./annotations.ts";

// Envelopes, Recipients and Fields (ADR-0006, T3.1): request and response shapes shared by
// workers/api and apps/web. Field geometry is page-relative 0..1, origin top-left, like
// Annotations.

declare const envelopeIdBrand: unique symbol;
declare const recipientIdBrand: unique symbol;
declare const fieldIdBrand: unique symbol;

/** An Envelope's identifier (`env_…`), unique within its Tenant. */
export type EnvelopeId = string & { readonly [envelopeIdBrand]: true };
/** A Recipient's identifier (`rcp_…`), unique within its Envelope. */
export type RecipientId = string & { readonly [recipientIdBrand]: true };
/** A Field's identifier (`fld_…`), unique within its Envelope. */
export type FieldId = string & { readonly [fieldIdBrand]: true };

export const ENVELOPE_STATUSES = [
  "draft",
  "sent",
  "completing",
  "completed",
  "declined",
  "voided",
  "expired",
] as const;
export const EnvelopeStatus = z.enum(ENVELOPE_STATUSES);
export type EnvelopeStatus = z.infer<typeof EnvelopeStatus>;

/** The moves an Envelope's status can make; anything else is a 409. */
export const ENVELOPE_TRANSITIONS: Readonly<Record<EnvelopeStatus, readonly EnvelopeStatus[]>> = {
  draft: ["sent"],
  sent: ["completing", "declined", "voided", "expired"],
  completing: ["completed"],
  completed: [],
  declined: [],
  voided: [],
  expired: [],
};

export function canTransition(from: EnvelopeStatus, to: EnvelopeStatus): boolean {
  return ENVELOPE_TRANSITIONS[from].includes(to);
}

export const RECIPIENT_STATUSES = ["waiting", "sent", "viewed", "signed", "declined"] as const;
export const RecipientStatus = z.enum(RECIPIENT_STATUSES);
export type RecipientStatus = z.infer<typeof RecipientStatus>;

export const RECIPIENT_ROLES = ["signer", "cc"] as const;
export const RecipientRole = z.enum(RECIPIENT_ROLES);
export type RecipientRole = z.infer<typeof RecipientRole>;

export const ORDER_MODES = ["parallel", "sequential"] as const;
export const OrderMode = z.enum(ORDER_MODES);
export type OrderMode = z.infer<typeof OrderMode>;

export const FIELD_KINDS = ["signature", "initials", "date", "text", "checkbox"] as const;
export const FieldKind = z.enum(FIELD_KINDS);
export type FieldKind = z.infer<typeof FieldKind>;

export const ENVELOPE_EXPIRY_DAYS = { default: 30, min: 1, max: 90 } as const;

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const RecipientIdText = z.string().regex(/^rcp_[A-Za-z0-9]{1,60}$/, "Recipient ids start with rcp_");
const FieldIdText = z.string().regex(/^fld_[A-Za-z0-9]{1,60}$/, "Field ids start with fld_");

export const EnvelopeCreate = z.object({ documentId: Id });
export type EnvelopeCreate = z.infer<typeof EnvelopeCreate>;

export const RecipientInput = z.object({
  /** Kept when given, so a client can refer to a Recipient across saves; minted otherwise. */
  id: RecipientIdText.optional(),
  name: z.string().trim().min(1, "Every recipient needs a name").max(200),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address")),
  role: RecipientRole,
  routingOrder: z.number().int().min(1).max(100).default(1),
});
export type RecipientInput = z.infer<typeof RecipientInput>;

export const FieldInput = z.object({
  id: FieldIdText.optional(),
  recipientId: RecipientIdText,
  kind: FieldKind,
  page: z.number().int().min(1).max(10_000),
  rect: Rect,
  required: z.boolean().default(true),
});
export type FieldInput = z.infer<typeof FieldInput>;

/** `PUT /api/envelopes/:id`: the whole draft, replacing what was saved. */
export const EnvelopeDraft = z
  .object({
    title: z.string().trim().min(1, "Give the envelope a title").max(200),
    message: z.string().trim().max(2000).default(""),
    orderMode: OrderMode.default("parallel"),
    expiresInDays: z
      .number()
      .int()
      .min(ENVELOPE_EXPIRY_DAYS.min)
      .max(ENVELOPE_EXPIRY_DAYS.max)
      .default(ENVELOPE_EXPIRY_DAYS.default),
    recipients: z.array(RecipientInput).max(20).default([]),
    fields: z.array(FieldInput).max(500).default([]),
  })
  .superRefine((draft, ctx) => {
    const ids = draft.recipients.flatMap((r) => (r.id === undefined ? [] : [r.id]));
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "Two recipients have the same id" });
    }
    const fieldIds = draft.fields.flatMap((f) => (f.id === undefined ? [] : [f.id]));
    if (new Set(fieldIds).size !== fieldIds.length) {
      ctx.addIssue({ code: "custom", message: "Two fields have the same id" });
    }
    if (draft.fields.some((f) => !ids.includes(f.recipientId))) {
      ctx.addIssue({ code: "custom", message: "A field belongs to a recipient not on this draft" });
    }
  });
export type EnvelopeDraft = z.infer<typeof EnvelopeDraft>;

export const EnvelopeVoid = z.object({
  reason: z.string().trim().min(1, "Say why you are voiding it").max(500),
});
export type EnvelopeVoid = z.infer<typeof EnvelopeVoid>;

export const EnvelopeListQuery = z.object({ status: EnvelopeStatus.optional() });

export const EnvelopeInfo = z.object({
  id: z.string(),
  documentId: z.string(),
  /** The Version being signed, pinned when the draft was created. */
  version: z.number().int(),
  title: z.string(),
  message: z.string(),
  status: EnvelopeStatus,
  orderMode: OrderMode,
  expiresInDays: z.number().int(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sentAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  finalVersion: z.number().int().nullable(),
});
export type EnvelopeInfo = z.infer<typeof EnvelopeInfo>;

export const RecipientInfo = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: RecipientRole,
  routingOrder: z.number().int(),
  status: RecipientStatus,
  notifiedAt: z.number().nullable(),
  viewedAt: z.number().nullable(),
  signedAt: z.number().nullable(),
  declinedAt: z.number().nullable(),
  declineReason: z.string().nullable(),
});
export type RecipientInfo = z.infer<typeof RecipientInfo>;

export const FieldInfo = z.object({
  id: z.string(),
  recipientId: z.string(),
  kind: FieldKind,
  page: z.number().int(),
  rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  required: z.boolean(),
  value: z.string().nullable(),
});
export type FieldInfo = z.infer<typeof FieldInfo>;

export const EnvelopeResponse = z.object({
  envelope: EnvelopeInfo,
  recipients: z.array(RecipientInfo),
  fields: z.array(FieldInfo),
});
export type EnvelopeResponse = z.infer<typeof EnvelopeResponse>;

export const EnvelopeListResponse = z.object({ envelopes: z.array(EnvelopeInfo) });

/** Every field `auditHash` covers, so a client can recompute the chain with `verifyChain`. */
export const AuditEventInfo = z.object({
  tenantId: z.string(),
  subjectType: z.literal("envelope"),
  subjectId: z.string(),
  seq: z.number().int(),
  actor: z.string(),
  action: z.string(),
  detail: z.record(z.string(), z.unknown()),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  at: z.number(),
  prevHash: z.string(),
  hash: z.string(),
});

export const AuditTrailResponse = z.object({
  events: z.array(AuditEventInfo),
  chain: z.object({ valid: z.boolean(), head: z.string() }),
});

/** What send checks a draft against: its Recipients, Fields and the pinned Version's pages. */
export interface SendCheck {
  readonly recipients: readonly Pick<RecipientInfo, "id" | "name" | "email" | "role">[];
  readonly fields: readonly Pick<FieldInfo, "recipientId" | "kind" | "page">[];
  readonly pages: number;
}

/** The first reason a draft cannot be sent, in the sender's words; null when it can. */
export function sendProblem({ recipients, fields, pages }: SendCheck): string | null {
  const signers = recipients.filter((r) => r.role === "signer");
  if (signers.length === 0) return "Add at least one signer";
  const emails = recipients.map((r) => r.email.toLowerCase());
  const repeated = emails.find((e, i) => emails.indexOf(e) !== i);
  if (repeated !== undefined) return `${repeated} is on this envelope twice`;
  const pageLabel = pages === 1 ? "1 page" : `${String(pages)} pages`;
  const offPage = fields.find((f) => f.page > pages);
  if (offPage) {
    return `A field is on page ${String(offPage.page)}, but the document has ${pageLabel}`;
  }
  for (const cc of recipients.filter((r) => r.role === "cc")) {
    if (fields.some((f) => f.recipientId === cc.id)) {
      return `${cc.name} gets a copy (CC) and can't have fields`;
    }
  }
  for (const signer of signers) {
    if (!fields.some((f) => f.recipientId === signer.id && f.kind === "signature")) {
      return `${signer.name} has no signature field`;
    }
  }
  return null;
}

/** The signers whose turn it is at send: all of them in parallel, the lowest routing order in sequential. */
export function firstTurn<R extends Pick<RecipientInfo, "role" | "routingOrder">>(
  recipients: readonly R[],
  orderMode: OrderMode,
): R[] {
  const signers = recipients.filter((r) => r.role === "signer");
  if (orderMode === "parallel") return signers;
  const first = Math.min(...signers.map((r) => r.routingOrder));
  return signers.filter((r) => r.routingOrder === first);
}
