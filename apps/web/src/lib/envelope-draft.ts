import {
  EnvelopeDraft,
  sendProblem,
  type EnvelopeResponse,
  type FieldKind,
  type OrderMode,
  type Rect,
  type RecipientRole,
} from "@inkly/domain";

// The draft editor's state and the pure moves on it. The editor saves the whole draft with
// PUT (T3.1 replaces it), so Recipient and Field ids are minted here and kept across saves.

export interface DraftRecipient {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: RecipientRole;
}

export interface DraftField {
  readonly id: string;
  readonly recipientId: string;
  readonly kind: FieldKind;
  readonly page: number;
  readonly rect: Rect;
  readonly required: boolean;
}

/** Recipients in routing order: the list order is the order a sequential Envelope signs in. */
export interface Draft {
  readonly title: string;
  readonly message: string;
  readonly orderMode: OrderMode;
  readonly expiresInDays: number;
  readonly recipients: readonly DraftRecipient[];
  readonly fields: readonly DraftField[];
}

export const KIND_LABEL: Record<FieldKind, string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date",
  text: "Text",
  checkbox: "Checkbox",
};

/** Only text and checkbox fields can be optional; the rest are what signing means. */
export const OPTIONAL_KINDS: ReadonlySet<FieldKind> = new Set(["text", "checkbox"]);

export const INK_COUNT = 6;

/** The token that inks a Recipient's fields, by their place in the list; values in tokens.css. */
export function inkVar(index: number): string {
  return `var(--recipient-${String((index % INK_COUNT) + 1)})`;
}

/** The tinted surface under that Recipient's fields. */
export function fillVar(index: number): string {
  return `var(--recipient-${String((index % INK_COUNT) + 1)}-fill)`;
}

export function newId(prefix: "rcp" | "fld"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function fromResponse({ envelope, recipients, fields }: EnvelopeResponse): Draft {
  return {
    title: envelope.title,
    message: envelope.message,
    orderMode: envelope.orderMode,
    expiresInDays: envelope.expiresInDays,
    recipients: recipients.map(({ id, name, email, role }) => ({ id, name, email, role })),
    fields: fields.map(({ id, recipientId, kind, page, rect, required }) => ({
      id,
      recipientId,
      kind,
      page,
      rect,
      required,
    })),
  };
}

/** The PUT body: routing order is each Recipient's place in the list. */
export function toBody(draft: Draft) {
  return {
    ...draft,
    recipients: draft.recipients.map((r, i) => ({ ...r, routingOrder: i + 1 })),
  };
}

/** The first reason the API would refuse to save this draft, or null. */
export function saveProblem(draft: Draft): string | null {
  const parsed = EnvelopeDraft.safeParse(toBody(draft));
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "This draft is incomplete");
}

/** The first reason send would refuse this draft, the server's check run on the client. */
export function draftProblem(draft: Draft, pages: number): string | null {
  return saveProblem(draft) ?? sendProblem({ ...draft, pages });
}

/** Moves a Recipient `delta` places up (negative) or down the routing order. */
export function moveRecipient(draft: Draft, id: string, delta: number): Draft {
  const from = draft.recipients.findIndex((r) => r.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= draft.recipients.length) return draft;
  const recipients = [...draft.recipients];
  const [moved] = recipients.splice(from, 1);
  if (moved) recipients.splice(to, 0, moved);
  return { ...draft, recipients };
}

/** Removes a Recipient and every field they were to fill in. */
export function removeRecipient(draft: Draft, id: string): Draft {
  return {
    ...draft,
    recipients: draft.recipients.filter((r) => r.id !== id),
    fields: draft.fields.filter((f) => f.recipientId !== id),
  };
}
