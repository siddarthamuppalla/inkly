import {
  emailSender,
  mintEnvelopeId,
  mintFieldId,
  mintRecipientId,
  mintSignerToken,
  mintSigningCode,
  signingCodeMatches,
  type Mail,
  type OpenSigner,
} from "@inkly/auth";
import {
  AppError,
  canTransition,
  chained,
  CONSENT_TEXT,
  envelopeLimitError,
  everySignerSigned,
  fieldFilled,
  fieldValueProblem,
  firstTurn,
  GENESIS,
  isAppError,
  nextTurn,
  PLAN_LIMITS,
  sendProblem,
  sha256Hex,
  SIGNING_CODE,
  signingDate,
  type SignerSign,
  type AppErrorCode,
  type AuditAction,
  type AuditEvent,
  type EnvelopeDraft,
  type EnvelopeId,
  type EnvelopeStatus,
  type FieldId,
  type JsonValue,
  type RecipientId,
  type TenantId,
  type UserId,
} from "@inkly/domain";
import { logEvent } from "@inkly/domain/log";
import { inspect } from "@inkly/pdf";
import {
  addVersion,
  auditHead,
  getEnvelope,
  getVersion,
  listAuditEvents,
  listFields,
  listMembers,
  listRecipients,
  listVersions,
  openVersion,
  type DocumentRow,
  type EnvelopeRow,
  type FieldRow,
  type RecipientRow,
} from "@inkly/storage";
import {
  claimEnvelope,
  commitEnvelope,
  deleteDraft,
  insertEnvelope,
  readSignerSecrets,
  releaseEnvelope,
  replaceDraft,
  type EnvelopePatch,
  type RecipientPatch,
} from "@inkly/storage/envelopes";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env.ts";
import { tenantPlan } from "../upload.ts";
import { SIGNED_PDF_DAYS } from "./content.ts";
import { ALL_SIGNED, type LifecycleParams } from "./lifecycle-event.ts";
import { sealKey } from "./seal-key.ts";
import { sealEnvelopePdf } from "./seal-pdf.ts";

// Envelope (GLOSSARY, ADR-0006): one per Envelope, named `{tenantId}/{envelopeId}`, the only
// writer of its envelopes, recipients, fields and audit_events rows. Each mutation runs inside
// blockConcurrencyWhile, so the status machine and the hash chain never see two writers.
// Only the API Worker binds it, and it calls in only after an Envelope lookup in the caller's
// Tenant, or after packages/auth resolves a signer token (the signer methods below, T3.3).

export interface EnvelopeRef {
  readonly tenantId: TenantId;
  readonly envelopeId: EnvelopeId;
}

/** Who is acting and where the request came from, for the audit trail and emails. */
export interface Sender {
  readonly userId: UserId;
  readonly name: string;
  readonly email: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** A signer on their own link: the Recipient packages/auth resolved, and the link's hash. */
export interface Signer {
  readonly recipientId: RecipientId;
  readonly tokenHash: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface EnvelopeDetail {
  readonly envelope: EnvelopeRow;
  readonly recipients: RecipientRow[];
  readonly fields: FieldRow[];
}

export type EnvelopeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: AppErrorCode; readonly message: string };

/** Who sent `envelope`, as signers see them: the Member who drafted it. */
export async function envelopeSender(
  env: Env,
  tenantId: TenantId,
  envelope: EnvelopeRow,
): Promise<{ name: string; email: string }> {
  const member = (await listMembers(tenantId, env)).find((m) => m.userId === envelope.createdBy);
  const email = member?.email ?? "";
  return { name: member?.name.trim() || email.split("@")[0] || "An Inkly user", email };
}

/** The Envelope DO of `envelope`. Taking the looked-up row keeps callers from skipping the lookup. */
export function envelopeObject(env: Env, tenantId: TenantId, envelope: EnvelopeRow) {
  return env.ENVELOPES.get(env.ENVELOPES.idFromName(`${tenantId}/${envelope.id}`));
}

/** The Envelope DO a signer link belongs to. Taking the resolved link keeps callers from skipping packages/auth. */
export function signerObject(env: Env, signer: OpenSigner) {
  return env.ENVELOPES.get(env.ENVELOPES.idFromName(`${signer.tenantId}/${signer.envelopeId}`));
}

/** A new Envelope's id and DO, for a draft of `doc` (already looked up in `tenantId`). */
export function newEnvelopeObject(env: Env, tenantId: TenantId, doc: DocumentRow) {
  const ref: EnvelopeRef = { tenantId, envelopeId: mintEnvelopeId() };
  const stub = env.ENVELOPES.get(env.ENVELOPES.idFromName(`${tenantId}/${ref.envelopeId}`));
  return { ref, stub, doc: { id: doc.id, version: doc.currentVersion, title: doc.title } };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const hex = (digest: ArrayBuffer): string =>
  [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Recipients holding a live link: notified signers who have not signed or declined. */
const PENDING: readonly RecipientRow["status"][] = ["sent", "viewed"];

interface EventInput {
  readonly action: AuditAction;
  readonly detail: { readonly [key: string]: JsonValue };
}

interface Actor {
  readonly id: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** The Workflow's actor: audit events it causes name no Member or signer. */
const SYSTEM: Actor = { id: "system", ip: null, userAgent: null };

/** DO storage key of the sealed sha256 that finalize is writing as a Version. */
const SEALING = "sealing";

const actorOf = (sender: Sender): Actor => ({
  id: sender.userId,
  ip: sender.ip,
  userAgent: sender.userAgent,
});

function conflict(message: string): AppError {
  return new AppError("conflict", message);
}

/** Every refusal of a link that stopped working; the signer is not told why. */
function linkGone(): AppError {
  return new AppError("not_found", "This link is no longer available");
}

const signerActor = (signer: Signer): Actor => ({
  id: signer.recipientId,
  ip: signer.ip,
  userAgent: signer.userAgent,
});

/** What the `signed` event records of a value: images by their sha256, the rest as typed. */
function signedValue(kind: FieldRow["kind"], value: string | null): { [key: string]: JsonValue } {
  if (value !== null && (kind === "signature" || kind === "initials")) {
    return { sha256: sha256Hex(value) };
  }
  return { value };
}

export class Envelope extends DurableObject<Env> {
  async create(
    ref: EnvelopeRef,
    doc: { id: DocumentRow["id"]; version: number; title: string },
    sender: Sender,
  ): Promise<EnvelopeOutcome<EnvelopeDetail>> {
    return this.mutate(ref, async () => {
      const at = Date.now();
      const events = await this.events(ref, actorOf(sender), at, [
        {
          action: "created",
          detail: { documentId: doc.id, version: doc.version, title: doc.title },
        },
      ]);
      await insertEnvelope(
        ref.tenantId,
        this.env,
        {
          id: ref.envelopeId,
          documentId: doc.id,
          version: doc.version,
          title: doc.title,
          createdBy: sender.userId,
          at,
        },
        events,
      );
      return this.detail(ref);
    });
  }

  async updateDraft(
    ref: EnvelopeRef,
    draft: EnvelopeDraft,
  ): Promise<EnvelopeOutcome<EnvelopeDetail>> {
    return this.mutate(ref, async () => {
      this.assertDraft(await this.envelope(ref), "edited");
      const recipients = draft.recipients.map((r) => ({
        id: (r.id as RecipientId | undefined) ?? mintRecipientId(),
        name: r.name,
        email: r.email,
        role: r.role,
        routingOrder: r.routingOrder,
      }));
      const fields = draft.fields.map((f) => ({
        id: (f.id as FieldId | undefined) ?? mintFieldId(),
        recipientId: f.recipientId as RecipientId,
        kind: f.kind,
        page: f.page,
        rect: f.rect,
        required: f.required,
      }));
      const replaced = await replaceDraft(
        ref.tenantId,
        this.env,
        ref.envelopeId,
        Date.now(),
        {
          title: draft.title,
          message: draft.message,
          orderMode: draft.orderMode,
          expiresInDays: draft.expiresInDays,
        },
        recipients,
        fields,
      );
      if (!replaced) throw conflict("Only a draft can be edited");
      return this.detail(ref);
    });
  }

  async deleteDraft(ref: EnvelopeRef): Promise<EnvelopeOutcome<null>> {
    return this.mutate(ref, async () => {
      this.assertDraft(await this.envelope(ref), "deleted");
      await deleteDraft(ref.tenantId, this.env, ref.envelopeId);
      return null;
    });
  }

  /**
   * Validates the draft, counts it against the Plan's monthly Limit and emails a link to each
   * signer whose turn it is. Emails go out before the state is committed, so a refused or
   * failed send leaves the draft (and Usage) as they were.
   */
  async send(
    ref: EnvelopeRef,
    sender: Sender,
    origin: string,
  ): Promise<EnvelopeOutcome<EnvelopeDetail>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      this.assertDraft(envelope, "sent");
      const [recipients, fields, version] = await Promise.all([
        listRecipients(ref.tenantId, this.env, ref.envelopeId),
        listFields(ref.tenantId, this.env, ref.envelopeId),
        getVersion(ref.tenantId, this.env, envelope.documentId, envelope.version),
      ]);
      if (!version) throw new AppError("not_found", "The document version is gone");
      const problem = sendProblem({ recipients, fields, pages: version.pages });
      if (problem !== null) throw new AppError("invalid_input", problem);

      const plan = await tenantPlan(ref.tenantId, this.env);
      if (!(await claimEnvelope(ref.tenantId, this.env, PLAN_LIMITS[plan].envelopes))) {
        throw envelopeLimitError(plan);
      }
      try {
        const at = Date.now();
        const turn = firstTurn(recipients, envelope.orderMode);
        const notified = await this.notify(envelope, turn, sender, origin, "invite");
        const expiresAt = at + envelope.expiresInDays * DAY_MS;
        const events = await this.events(ref, actorOf(sender), at, [
          {
            action: "sent",
            detail: {
              documentId: envelope.documentId,
              version: envelope.version,
              sha256: version.sha256,
              orderMode: envelope.orderMode,
              expiresAt,
              recipients: recipients.map((r) => ({
                id: r.id,
                name: r.name,
                email: r.email,
                role: r.role,
                routingOrder: r.routingOrder,
              })),
            },
          },
          ...notified.map((n) => ({
            action: "notified" as const,
            detail: { recipientId: n.id, email: n.email },
          })),
        ]);
        await this.commit(ref, at, {
          envelope: { status: this.next(envelope, "sent"), sentAt: at, expiresAt },
          recipients: notified.map((n) => ({
            id: n.id,
            patch: { status: "sent", tokenHash: n.tokenHash, notifiedAt: at },
          })),
          events,
        });
      } catch (err) {
        await releaseEnvelope(ref.tenantId, this.env);
        throw err;
      }
      await this.startLifecycle(ref, origin);
      return this.detail(ref);
    });
  }

  /** Ends a sent Envelope: its links stop working and pending signers are told why. */
  async voidEnvelope(
    ref: EnvelopeRef,
    sender: Sender,
    reason: string,
  ): Promise<EnvelopeOutcome<EnvelopeDetail>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      const status = this.next(envelope, "voided");
      const pending = (await listRecipients(ref.tenantId, this.env, ref.envelopeId)).filter(
        (r) => r.role === "signer" && PENDING.includes(r.status),
      );
      const at = Date.now();
      await this.commit(ref, at, {
        envelope: { status },
        events: await this.events(ref, actorOf(sender), at, [
          { action: "voided", detail: { reason } },
        ]),
      });
      await this.stopLifecycle(ref);
      await this.mailAll(
        pending.map((r) => ({
          to: r.email,
          subject: `"${envelope.title}" was voided`,
          text: [
            `Hi ${r.name},`,
            "",
            `${sender.name} voided "${envelope.title}", so it no longer needs your signature.`,
            `Reason: ${reason}`,
            "",
            "The signing link you were sent no longer works.",
          ].join("\n"),
        })),
      );
      return this.detail(ref);
    });
  }

  /**
   * Emails each pending signer again. Only token hashes are stored, so a reminder carries a
   * fresh link and the previous one stops working. T3.5's Workflow calls this as "system".
   */
  async remind(
    ref: EnvelopeRef,
    sender: Sender,
    origin: string,
  ): Promise<EnvelopeOutcome<EnvelopeDetail>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      if (envelope.status !== "sent") throw conflict("Only a sent envelope can be reminded");
      const pending = (await listRecipients(ref.tenantId, this.env, ref.envelopeId)).filter(
        (r) => r.role === "signer" && PENDING.includes(r.status),
      );
      const at = Date.now();
      const reminded = await this.notify(envelope, pending, sender, origin, "reminder");
      await this.commit(ref, at, {
        recipients: reminded.map((n) => ({ id: n.id, patch: { tokenHash: n.tokenHash } })),
        events: await this.events(
          ref,
          actorOf(sender),
          at,
          reminded.map((n) => ({
            action: "reminded",
            detail: { recipientId: n.id, email: n.email },
          })),
        ),
      });
      return this.detail(ref);
    });
  }

  /** Records the signer's first look at the document. Later opens change nothing. */
  async viewed(ref: EnvelopeRef, signer: Signer): Promise<EnvelopeOutcome<null>> {
    return this.mutate(ref, async () => {
      const { recipient } = await this.signerTurn(ref, signer);
      if (recipient.viewedAt !== null) return null;
      const at = Date.now();
      await this.commit(ref, at, {
        recipients: [{ id: recipient.id, patch: { status: "viewed", viewedAt: at } }],
        events: await this.events(ref, signerActor(signer), at, [
          { action: "viewed", detail: { recipientId: recipient.id } },
        ]),
      });
      return null;
    });
  }

  /** Emails a fresh Signing code to the address the link was sent to; the previous code stops working. */
  async sendCode(ref: EnvelopeRef, signer: Signer): Promise<EnvelopeOutcome<null>> {
    return this.mutate(ref, async () => {
      const { envelope, recipient } = await this.signerTurn(ref, signer);
      const { code, codeHash } = await mintSigningCode(this.env, recipient.id);
      await emailSender(this.env).send({
        to: recipient.email,
        subject: `Your signing code for "${envelope.title}"`,
        text: [
          `Hi ${recipient.name},`,
          "",
          `Your code to open "${envelope.title}" for signing is ${code}.`,
          "It expires in 10 minutes. If you did not ask for it, you can ignore this email.",
        ].join("\n"),
      });
      const at = Date.now();
      await this.commit(ref, at, {
        recipients: [
          {
            id: recipient.id,
            patch: { codeHash, codeExpiresAt: at + SIGNING_CODE.ttlMs, codeAttempts: 0 },
          },
        ],
        events: await this.events(ref, signerActor(signer), at, [
          { action: "code_sent", detail: { recipientId: recipient.id, email: recipient.email } },
        ]),
      });
      return null;
    });
  }

  /**
   * Checks a Signing code. A right one is used up and audited with the signer's IP and user
   * agent; the fifth wrong one invalidates the code.
   */
  async verifyCode(ref: EnvelopeRef, signer: Signer, code: string): Promise<EnvelopeOutcome<null>> {
    return this.mutate(ref, async () => {
      const { recipient, secrets } = await this.signerTurn(ref, signer);
      const at = Date.now();
      if (secrets.codeHash === null || (secrets.codeExpiresAt ?? 0) <= at) {
        throw new AppError("unauthenticated", "This code has expired. Ask for a new one.");
      }
      if (!(await signingCodeMatches(this.env, recipient.id, code, secrets.codeHash))) {
        const attempts = secrets.codeAttempts + 1;
        const spent = attempts >= SIGNING_CODE.maxAttempts;
        await this.commit(ref, at, {
          recipients: [
            {
              id: recipient.id,
              patch: {
                codeAttempts: attempts,
                ...(spent ? { codeHash: null, codeExpiresAt: null } : {}),
              },
            },
          ],
          events: [],
        });
        throw new AppError(
          "unauthenticated",
          spent ? "Too many wrong codes. Ask for a new one." : "That code is not right",
        );
      }
      await this.commit(ref, at, {
        recipients: [
          {
            id: recipient.id,
            patch: {
              codeHash: null,
              codeExpiresAt: null,
              codeAttempts: 0,
              verifiedIp: signer.ip,
              verifiedUserAgent: signer.userAgent,
            },
          },
        ],
        events: await this.events(ref, signerActor(signer), at, [
          {
            action: "verified",
            detail: { recipientId: recipient.id, email: recipient.email, method: "email_code" },
          },
        ]),
      });
      return null;
    });
  }

  /**
   * Fills the signer's Fields and records their signature. In sequential order the next
   * routing order is notified in the same change; once every signer has signed the
   * Envelope begins completion (T3.5 finalizes it).
   */
  async sign(
    ref: EnvelopeRef,
    signer: Signer,
    input: SignerSign,
    origin: string,
  ): Promise<EnvelopeOutcome<null>> {
    return this.mutate(ref, async () => {
      const { envelope, recipients, recipient } = await this.signerTurn(ref, signer);
      const fields = await listFields(ref.tenantId, this.env, ref.envelopeId);
      for (const id of Object.keys(input.values)) {
        const field = fields.find((f) => f.id === id);
        if (!field) throw new AppError("invalid_input", "That field is not on this envelope");
        if (field.recipientId !== recipient.id) {
          throw new AppError("invalid_input", "That field belongs to another recipient");
        }
      }
      const at = Date.now();
      const values = fields
        .filter((f) => f.recipientId === recipient.id)
        .map((field) => {
          const given = input.values[field.id];
          const value = field.kind === "date" ? signingDate(at) : given?.trim() ? given : null;
          if (field.required && !fieldFilled(field.kind, value)) {
            throw new AppError("invalid_input", "Fill in every required field before you finish");
          }
          const problem = value === null ? null : fieldValueProblem(field.kind, value);
          if (problem !== null) throw new AppError("invalid_input", problem);
          return { field, value };
        });

      const after = recipients.map((r) =>
        r.id === recipient.id ? { ...r, status: "signed" as const } : r,
      );
      const turn = nextTurn(after, envelope.orderMode);
      const sender =
        turn.length > 0 ? await envelopeSender(this.env, ref.tenantId, envelope) : null;
      const notified = sender ? await this.notify(envelope, turn, sender, origin, "invite") : [];
      await this.commit(ref, at, {
        recipients: [
          { id: recipient.id, patch: { status: "signed", signedAt: at, codeHash: null } },
          ...notified.map((n) => ({
            id: n.id,
            patch: { status: "sent" as const, tokenHash: n.tokenHash, notifiedAt: at },
          })),
        ],
        fields: values.map(({ field, value }) => ({ id: field.id, value })),
        events: await this.events(ref, signerActor(signer), at, [
          {
            action: "signed",
            detail: {
              recipientId: recipient.id,
              consent: CONSENT_TEXT,
              fields: values.map(({ field, value }) => ({
                id: field.id,
                kind: field.kind,
                ...signedValue(field.kind, value),
              })),
            },
          },
          ...notified.map((n) => ({
            action: "notified" as const,
            detail: { recipientId: n.id, email: n.email },
          })),
        ]),
      });
      if (everySignerSigned(after)) await this.beginCompletion(ref, envelope, origin);
      return null;
    });
  }

  /** Ends the Envelope at the signer's request: every link stops working and the sender is told. */
  async decline(ref: EnvelopeRef, signer: Signer, reason: string): Promise<EnvelopeOutcome<null>> {
    return this.mutate(ref, async () => {
      const { envelope, recipient } = await this.signerTurn(ref, signer);
      const status = this.next(envelope, "declined");
      const at = Date.now();
      await this.commit(ref, at, {
        envelope: { status },
        recipients: [
          {
            id: recipient.id,
            patch: { status: "declined", declinedAt: at, declineReason: reason, codeHash: null },
          },
        ],
        events: await this.events(ref, signerActor(signer), at, [
          { action: "declined", detail: { recipientId: recipient.id, reason } },
        ]),
      });
      await this.stopLifecycle(ref);
      const sender = await envelopeSender(this.env, ref.tenantId, envelope);
      if (sender.email) {
        await this.mailAll([
          {
            to: sender.email,
            subject: `${recipient.name} declined to sign "${envelope.title}"`,
            text: [
              `Hi ${sender.name},`,
              "",
              `${recipient.name} (${recipient.email}) declined to sign "${envelope.title}".`,
              `Reason: ${reason}`,
              "",
              "The envelope is closed and its signing links no longer work.",
            ].join("\n"),
          },
        ]);
      }
      return null;
    });
  }

  // T3.5 completion: what the EnvelopeLifecycle Workflow (lifecycle.ts) calls, and the seam
  // the last signature ends with. Each is idempotent on the Envelope's status.

  /**
   * Moves a sent Envelope whose signers have all signed to `completing` and tells its
   * Workflow, which finalizes it. Again on a completing Envelope, it only tells the Workflow.
   * It takes its own blockConcurrencyWhile, so call it after a signing mutation, not inside
   * one; inside one, call `beginCompletion`.
   */
  async markAllSigned(ref: EnvelopeRef, origin: string): Promise<EnvelopeOutcome<EnvelopeDetail>> {
    return this.mutate(ref, async () => {
      await this.beginCompletion(ref, await this.envelope(ref), origin);
      return this.detail(ref);
    });
  }

  /** What the Workflow decides each round on: the status, the expiry and the time now. */
  async lifecycleState(
    ref: EnvelopeRef,
  ): Promise<EnvelopeOutcome<{ status: EnvelopeStatus; expiresAt: number | null; at: number }>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      return { status: envelope.status, expiresAt: envelope.expiresAt, at: Date.now() };
    });
  }

  /**
   * The Workflow's reminder `round`: a fresh link to each pending signer, audited `reminded`
   * as "system". A round that already ran, or an Envelope no longer sent, is left as it is.
   */
  async remindPending(
    ref: EnvelopeRef,
    round: number,
    origin: string,
  ): Promise<EnvelopeOutcome<{ reminded: number }>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      if (envelope.status !== "sent") return { reminded: 0 };
      const trail = await listAuditEvents(ref.tenantId, this.env, "envelope", ref.envelopeId);
      if (trail.some((e) => e.action === "reminded" && e.detail["round"] === round)) {
        return { reminded: 0 };
      }
      const pending = (await listRecipients(ref.tenantId, this.env, ref.envelopeId)).filter(
        (r) => r.role === "signer" && PENDING.includes(r.status),
      );
      const at = Date.now();
      const sender = await this.creator(ref, envelope);
      const reminded = await this.notify(envelope, pending, sender, origin, "reminder");
      await this.commit(ref, at, {
        recipients: reminded.map((n) => ({ id: n.id, patch: { tokenHash: n.tokenHash } })),
        events: await this.events(
          ref,
          SYSTEM,
          at,
          reminded.map((n) => ({
            action: "reminded",
            detail: { recipientId: n.id, email: n.email, round },
          })),
        ),
      });
      return { reminded: reminded.length };
    });
  }

  /** Ends a sent Envelope at `expires_at`: its links stop working and the sender is told. */
  async expire(ref: EnvelopeRef): Promise<EnvelopeOutcome<{ status: EnvelopeStatus }>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      if (envelope.status !== "sent") return { status: envelope.status };
      const status = this.next(envelope, "expired");
      const at = Date.now();
      await this.commit(ref, at, {
        envelope: { status },
        events: await this.events(ref, SYSTEM, at, [
          { action: "expired", detail: { expiresAt: envelope.expiresAt } },
        ]),
      });
      const sender = await this.creator(ref, envelope);
      await this.mailAll([
        {
          to: sender.email,
          subject: `"${envelope.title}" expired`,
          text: [
            `Hi ${sender.name},`,
            "",
            `"${envelope.title}" expired before everyone signed, so its signing links no longer work.`,
            "Send the document again to collect the missing signatures.",
          ].join("\n"),
        },
      ]);
      return { status };
    });
  }

  /**
   * Finalize (GLOSSARY): stamps the Field values into the pinned Version, appends the
   * Certificate of completion, seals it and stores it as a new Version of the Document, then
   * marks the Envelope `completed` and emails everyone a download link. A failure (no seal
   * key, storage) is a refusal that leaves it `completing` for the Workflow to retry.
   */
  async finalize(
    ref: EnvelopeRef,
    origin: string,
  ): Promise<EnvelopeOutcome<{ version: number; sha256: string }>> {
    return this.mutate(ref, async () => {
      const envelope = await this.envelope(ref);
      if (envelope.status === "completed" && envelope.finalVersion !== null) {
        const final = await getVersion(
          ref.tenantId,
          this.env,
          envelope.documentId,
          envelope.finalVersion,
        );
        return { version: envelope.finalVersion, sha256: final?.sha256 ?? "" };
      }
      const status = this.next(envelope, "completed");
      const recipients = await listRecipients(ref.tenantId, this.env, ref.envelopeId);
      const sealed = await this.sealedVersion(ref, envelope, recipients);

      // Only token hashes are stored, so each Recipient gets a fresh link to the signed PDF.
      const minted = await Promise.all(
        recipients.map(async (r) => ({ recipient: r, ...(await mintSignerToken()) })),
      );
      await this.commit(ref, sealed.at, {
        envelope: { status, completedAt: sealed.at, finalVersion: sealed.version },
        recipients: minted.map(({ recipient, tokenHash }) => ({
          id: recipient.id,
          patch: { tokenHash },
        })),
        events: await this.events(ref, SYSTEM, sealed.at, [
          { action: "completed", detail: { version: sealed.version, sha256: sealed.sha256 } },
        ]),
      });
      await this.ctx.storage.delete(SEALING);
      const sender = await this.creator(ref, envelope);
      await this.mailAll([
        ...minted.map(({ recipient, token }) => ({
          to: recipient.email,
          subject: `"${envelope.title}" is complete`,
          text: [
            `Hi ${recipient.name},`,
            "",
            recipient.role === "cc"
              ? `${sender.name} (${sender.email}) sent you a copy of "${envelope.title}", now signed by everyone.`
              : `Everyone has signed "${envelope.title}", sent by ${sender.name} (${sender.email}).`,
            "",
            `Download the signed PDF: ${new URL(`/sign/${token}`, origin).toString()}`,
            "",
            `The link works for ${String(SIGNED_PDF_DAYS)} days and replaces any earlier one. Don't forward it.`,
          ].join("\n"),
        })),
        {
          to: sender.email,
          subject: `Everyone signed "${envelope.title}"`,
          text: [
            `Hi ${sender.name},`,
            "",
            `Everyone has signed "${envelope.title}". The signed PDF, with its Certificate of completion, is now the document's latest version.`,
            "",
            `View it: ${new URL(`/envelopes/${ref.envelopeId}`, origin).toString()}`,
          ].join("\n"),
        },
      ]);
      return { version: sealed.version, sha256: sealed.sha256 };
    });
  }

  /**
   * Moves a sent Envelope to `completing` once every signer has signed, then tells its
   * Workflow; on a completing Envelope it only tells the Workflow. For use inside a mutation.
   */
  private async beginCompletion(
    ref: EnvelopeRef,
    envelope: EnvelopeRow,
    origin: string,
  ): Promise<void> {
    if (envelope.status !== "completing") {
      const status = this.next(envelope, "completing");
      const signers = (await listRecipients(ref.tenantId, this.env, ref.envelopeId)).filter(
        (r) => r.role === "signer",
      );
      if (signers.some((r) => r.status !== "signed")) {
        throw conflict("Not every signer has signed yet");
      }
      await this.commit(ref, Date.now(), { envelope: { status }, events: [] });
    }
    try {
      const instance = await this.env.ENVELOPE_LIFECYCLE.get(ref.envelopeId);
      await instance.sendEvent({ type: ALL_SIGNED, payload: {} });
    } catch {
      // No instance (its start failed after the send): a new one finalizes the Envelope.
      await this.startLifecycle(ref, origin);
    }
  }

  /**
   * The sealed Version of `envelope`, added to its Document. Sealing is not deterministic
   * (the seal carries its time), so the sha256 is kept in DO storage before the Version is
   * written: a retry after that write landed finds the Version instead of adding a second.
   */
  private async sealedVersion(
    ref: EnvelopeRef,
    envelope: EnvelopeRow,
    recipients: readonly RecipientRow[],
  ): Promise<{ version: number; sha256: string; at: number }> {
    const pending = await this.ctx.storage.get<{ sha256: string; at: number }>(SEALING);
    if (pending) {
      const landed = await this.landedVersion(ref, envelope, pending.sha256);
      if (landed !== null) return { version: landed, ...pending };
    }

    const key = await sealKey(this.env);
    const [fields, events, original, sender] = await Promise.all([
      listFields(ref.tenantId, this.env, ref.envelopeId),
      listAuditEvents(ref.tenantId, this.env, "envelope", ref.envelopeId),
      openVersion(ref.tenantId, this.env, envelope.documentId, envelope.version),
      this.creator(ref, envelope),
    ]);
    if (!original) throw new AppError("not_found", "The document version is gone");
    const at = Date.now();
    const body = await sealEnvelopePdf(
      {
        envelope,
        recipients,
        fields,
        events,
        sender: { name: sender.name, email: sender.email },
        original: {
          bytes: new Uint8Array(await new Response(original.object.body).arrayBuffer()),
          sha256: original.version.sha256,
        },
        completedAt: at,
      },
      key,
    );
    const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
    await this.ctx.storage.put(SEALING, { sha256, at });
    const { pages } = await inspect(body);
    const added = await addVersion(ref.tenantId, this.env, envelope.documentId, {
      body,
      sha256,
      pages,
      createdBy: envelope.createdBy,
    });
    const version = added && (await this.landedVersion(ref, envelope, sha256));
    if (!version) throw new AppError("not_found", "The document is gone");
    return { version, sha256, at };
  }

  private async landedVersion(
    ref: EnvelopeRef,
    envelope: EnvelopeRow,
    sha256: string,
  ): Promise<number | null> {
    const versions = await listVersions(ref.tenantId, this.env, envelope.documentId);
    return versions.find((v) => v.sha256 === sha256 && v.n > envelope.version)?.n ?? null;
  }

  /** The Member who created `envelope`: the sender named in the Workflow's emails. */
  private async creator(ref: EnvelopeRef, envelope: EnvelopeRow): Promise<Sender> {
    const member = (await listMembers(ref.tenantId, this.env)).find(
      (m) => m.userId === envelope.createdBy,
    );
    const email = member?.email ?? "";
    return {
      userId: envelope.createdBy,
      name: member?.name.trim() || email.split("@")[0] || "An Inkly user",
      email,
      ip: null,
      userAgent: null,
    };
  }

  /** Starts the Envelope's Workflow. A failure is logged: the send has already happened. */
  private async startLifecycle(ref: EnvelopeRef, origin: string): Promise<void> {
    const params: LifecycleParams = { tenantId: ref.tenantId, envelopeId: ref.envelopeId, origin };
    try {
      await this.env.ENVELOPE_LIFECYCLE.create({ id: ref.envelopeId, params });
    } catch (err) {
      const entry = {
        event: "lifecycle_start_failed",
        envelopeId: ref.envelopeId,
        message: err instanceof Error ? err.message : String(err),
      };
      logEvent(entry);
    }
  }

  /** Ends the Envelope's Workflow now; otherwise it ends at its next round. */
  private async stopLifecycle(ref: EnvelopeRef): Promise<void> {
    try {
      await (await this.env.ENVELOPE_LIFECYCLE.get(ref.envelopeId)).terminate();
    } catch {
      // It has already ended, or never started.
    }
  }

  /**
   * The Envelope and Recipient behind a signer's link, while it is still their turn: a sent,
   * unexpired Envelope, a signer who has neither signed nor declined, and the link's hash
   * still the one stored (a reminder replaces it). Anything else is the same 404.
   */
  private async signerTurn(ref: EnvelopeRef, signer: Signer) {
    const [envelope, recipients, secrets] = await Promise.all([
      this.envelope(ref),
      listRecipients(ref.tenantId, this.env, ref.envelopeId),
      readSignerSecrets(ref.tenantId, this.env, ref.envelopeId, signer.recipientId),
    ]);
    const recipient = recipients.find((r) => r.id === signer.recipientId);
    const open =
      envelope.status === "sent" &&
      (envelope.expiresAt ?? Infinity) > Date.now() &&
      recipient?.role === "signer" &&
      PENDING.includes(recipient.status) &&
      secrets?.tokenHash === signer.tokenHash;
    if (!open) throw linkGone();
    return { envelope, recipients, recipient, secrets };
  }

  /** Runs one mutation alone; an AppError becomes a refusal instead of resetting the object. */
  private async mutate<T>(ref: EnvelopeRef, run: () => Promise<T>): Promise<EnvelopeOutcome<T>> {
    const expected = this.env.ENVELOPES.idFromName(`${ref.tenantId}/${ref.envelopeId}`);
    if (!expected.equals(this.ctx.id)) {
      return { ok: false, code: "not_found", message: "not found" };
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { ok: true, value: await run() } as const;
      } catch (err) {
        if (isAppError(err)) return { ok: false, code: err.code, message: err.message } as const;
        throw err;
      }
    });
  }

  private async envelope(ref: EnvelopeRef): Promise<EnvelopeRow> {
    const envelope = await getEnvelope(ref.tenantId, this.env, ref.envelopeId);
    if (!envelope) throw new AppError("not_found", "not found");
    return envelope;
  }

  private async detail(ref: EnvelopeRef): Promise<EnvelopeDetail> {
    const [envelope, recipients, fields] = await Promise.all([
      this.envelope(ref),
      listRecipients(ref.tenantId, this.env, ref.envelopeId),
      listFields(ref.tenantId, this.env, ref.envelopeId),
    ]);
    return { envelope, recipients, fields };
  }

  private assertDraft(envelope: EnvelopeRow, verb: string): void {
    if (envelope.status !== "draft") {
      throw conflict(`This envelope was already sent, so it can't be ${verb}`);
    }
  }

  /** `to`, when the status table allows the move from the Envelope's status; otherwise 409. */
  private next(envelope: EnvelopeRow, to: EnvelopeStatus): EnvelopeStatus {
    if (!canTransition(envelope.status, to)) {
      throw conflict(`A ${envelope.status} envelope can't be ${to}`);
    }
    return to;
  }

  /** `inputs` as the next events of the Envelope's hash chain. */
  private async events(
    ref: EnvelopeRef,
    actor: Actor,
    at: number,
    inputs: readonly EventInput[],
  ): Promise<AuditEvent[]> {
    const head = await auditHead(ref.tenantId, this.env, "envelope", ref.envelopeId);
    let prev = head?.hash ?? GENESIS;
    let seq = head?.seq ?? 0;
    return inputs.map((input) => {
      const event = chained(prev, {
        tenantId: ref.tenantId,
        subjectType: "envelope",
        subjectId: ref.envelopeId,
        seq: ++seq,
        actor: actor.id,
        action: input.action,
        detail: input.detail,
        ip: actor.ip,
        userAgent: actor.userAgent,
        at,
      });
      prev = event.hash;
      return event;
    });
  }

  private commit(
    ref: EnvelopeRef,
    at: number,
    change: {
      envelope?: EnvelopePatch;
      recipients?: { id: RecipientId; patch: RecipientPatch }[];
      fields?: { id: FieldId; value: string | null }[];
      events: AuditEvent[];
    },
  ): Promise<void> {
    return commitEnvelope(ref.tenantId, this.env, ref.envelopeId, { at, ...change });
  }

  /** Mints a link for each recipient and emails it; returns the hashes to store. */
  private async notify(
    envelope: EnvelopeRow,
    recipients: readonly RecipientRow[],
    sender: Pick<Sender, "name" | "email">,
    origin: string,
    kind: "invite" | "reminder",
  ): Promise<{ id: RecipientId; email: string; tokenHash: string }[]> {
    const minted = await Promise.all(
      recipients.map(async (r) => ({ recipient: r, ...(await mintSignerToken()) })),
    );
    const mailer = emailSender(this.env);
    for (const { recipient, token } of minted) {
      const link = new URL(`/sign/${token}`, origin).toString();
      const lead =
        kind === "invite"
          ? `${sender.name} (${sender.email}) sent you "${envelope.title}" to sign.`
          : `Reminder: ${sender.name} (${sender.email}) is waiting for your signature on "${envelope.title}".`;
      await mailer.send({
        to: recipient.email,
        subject:
          kind === "invite"
            ? `${sender.name} sent you "${envelope.title}" to sign`
            : `Reminder: please sign "${envelope.title}"`,
        text: [
          `Hi ${recipient.name},`,
          "",
          lead,
          ...(envelope.message ? ["", envelope.message] : []),
          "",
          `Review and sign: ${link}`,
          "",
          "This link is just for you. Don't forward it: it opens the document for signing.",
        ].join("\n"),
      });
    }
    return minted.map(({ recipient, tokenHash }) => ({
      id: recipient.id,
      email: recipient.email,
      tokenHash,
    }));
  }

  /** Sends notices that must not undo the change already committed; failures are logged. */
  private async mailAll(mails: readonly Mail[]): Promise<void> {
    const mailer = emailSender(this.env);
    for (const mail of mails) {
      try {
        await mailer.send(mail);
      } catch (err) {
        const entry = {
          event: "email_failed",
          message: err instanceof Error ? err.message : String(err),
        };
        logEvent(entry);
      }
    }
  }
}
