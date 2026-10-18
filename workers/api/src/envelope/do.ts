import {
  emailSender,
  mintEnvelopeId,
  mintFieldId,
  mintRecipientId,
  mintSignerToken,
  type Mail,
} from "@inkly/auth";
import {
  AppError,
  canTransition,
  chained,
  envelopeLimitError,
  firstTurn,
  GENESIS,
  isAppError,
  PLAN_LIMITS,
  sendProblem,
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
// Tenant (or, from T3.3, after packages/auth resolves a signer token).

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

export interface EnvelopeDetail {
  readonly envelope: EnvelopeRow;
  readonly recipients: RecipientRow[];
  readonly fields: FieldRow[];
}

export type EnvelopeOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: AppErrorCode; readonly message: string };

/** The Envelope DO of `envelope`. Taking the looked-up row keeps callers from skipping the lookup. */
export function envelopeObject(env: Env, tenantId: TenantId, envelope: EnvelopeRow) {
  return env.ENVELOPES.get(env.ENVELOPES.idFromName(`${tenantId}/${envelope.id}`));
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
      events: AuditEvent[];
    },
  ): Promise<void> {
    return commitEnvelope(ref.tenantId, this.env, ref.envelopeId, { at, ...change });
  }

  /** Mints a link for each recipient and emails it; returns the hashes to store. */
  private async notify(
    envelope: EnvelopeRow,
    recipients: readonly RecipientRow[],
    sender: Sender,
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
