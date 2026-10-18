import type { AuditEvent } from "@inkly/domain";
import {
  appendCertificate,
  sealPdf,
  stampFields,
  type CertificateParty,
  type CompletionCertificate,
  type SealKey,
} from "@inkly/pdf";
import type { EnvelopeRow, FieldRow, RecipientRow } from "@inkly/storage";

// Finalize's PDF work (GLOSSARY): stamp every Field value into the pinned Version, append the
// Certificate of completion and apply the Document seal. No I/O; the Envelope DO loads the
// inputs and stores the result.

export interface SealInput {
  readonly envelope: EnvelopeRow;
  readonly recipients: readonly RecipientRow[];
  readonly fields: readonly FieldRow[];
  readonly events: readonly AuditEvent[];
  readonly sender: CertificateParty;
  /** The pinned Version's bytes and sha256. */
  readonly original: { readonly bytes: Uint8Array; readonly sha256: string };
  readonly completedAt: number;
}

/** Where a Recipient signed from: the request that signed, else the one that verified the code. */
function signedFrom(events: readonly AuditEvent[], recipient: RecipientRow) {
  const own = events.filter((e) => e.actor === recipient.id);
  const event =
    own.findLast((e) => e.action === "signed") ?? own.findLast((e) => e.action === "verified");
  return { ip: event?.ip ?? null, userAgent: event?.userAgent ?? null };
}

export function completionCertificate(input: SealInput): CompletionCertificate {
  const { envelope, fields, events } = input;
  return {
    envelopeId: envelope.id,
    title: envelope.title,
    documentSha256: input.original.sha256,
    sentAt: envelope.sentAt ?? input.completedAt,
    completedAt: input.completedAt,
    sender: input.sender,
    recipients: input.recipients.map((r) => ({
      name: r.name,
      email: r.email,
      role: r.role,
      ...signedFrom(events, r),
      viewedAt: r.viewedAt,
      signedAt: r.signedAt,
      signature:
        fields.find((f) => f.recipientId === r.id && f.kind === "signature" && f.value !== null)
          ?.value ?? null,
    })),
    events: events.map((e) => ({
      seq: e.seq,
      at: e.at,
      actor: e.actor,
      action: e.action,
      hash: e.hash,
    })),
  };
}

/** The sealed PDF: stamped pages, then the Certificate of completion, under the Document seal. */
export async function sealEnvelopePdf(input: SealInput, key: SealKey): Promise<Uint8Array> {
  const stamped = await stampFields(
    input.original.bytes,
    input.fields.flatMap((f) =>
      f.value === null ? [] : [{ kind: f.kind, page: f.page, ...f.rect, value: f.value }],
    ),
  );
  const certified = await appendCertificate(stamped, completionCertificate(input));
  return sealPdf(certified, key);
}
