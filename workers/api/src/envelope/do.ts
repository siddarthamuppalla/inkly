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
import {
  auditHead,
  getEnvelope,
  getVersion,
  listFields,
  listMembers,
  listRecipients,
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
   * Envelope moves on to `allSigned`.
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
      if (everySignerSigned(after)) await this.allSigned(ref, envelope);
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

  /**
   * T3.5 seam: every signer has signed. For now this only moves the Envelope to
   * `completing`; T3.5 starts finalize (stamp, certificate, seal) from here.
   */
  private async allSigned(ref: EnvelopeRef, envelope: EnvelopeRow): Promise<void> {
    await this.commit(ref, Date.now(), {
      envelope: { status: this.next(envelope, "completing") },
      events: [],
    });
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
