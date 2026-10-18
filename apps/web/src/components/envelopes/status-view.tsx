import { EnvelopeVoid, type EnvelopeResponse, type RecipientInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState, type SyntheticEvent } from "react";
import { Link } from "react-router";

import { errorMessage } from "../../lib/api.ts";
import { saveFile } from "../../lib/download.ts";
import { envelopeKeys, envelopesApi } from "../../lib/envelopes-api.ts";
import { formatDateTime } from "../../lib/format.ts";
import { queryClient } from "../../lib/queries.ts";
import { useMe } from "../../lib/session.ts";
import { Page } from "../page.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../ui/sheet.tsx";
import { InkChip } from "./recipients-panel.tsx";
import { EnvelopeStatusBadge, RecipientStatusBadge } from "./status-badge.tsx";

const ACTION_LABEL: Record<string, string> = {
  created: "Draft created",
  sent: "Sent",
  notified: "Emailed a signing link",
  viewed: "Opened",
  code_sent: "Sent a sign-in code",
  verified: "Confirmed their email",
  signed: "Signed",
  declined: "Declined",
  voided: "Voided",
  expired: "Expired",
  reminded: "Reminded",
  completed: "Completed",
};

/** The Envelope after send: where each Recipient stands, its audit trail, and what is left to do. */
export function StatusView({ detail }: { readonly detail: EnvelopeResponse }) {
  const { envelope, recipients } = detail;
  const me = useMe();
  const canWrite = Boolean(me?.role) && me?.role !== "viewer";
  const [reminded, setReminded] = useState<number | null>(null);
  const settle = async (next: EnvelopeResponse) => {
    queryClient.setQueryData(envelopeKeys.envelope(envelope.id), next);
    await queryClient.invalidateQueries({ queryKey: envelopeKeys.all });
  };
  const remind = useMutation({
    mutationFn: () => envelopesApi.remind(envelope.id),
    onSuccess: async (next) => {
      setReminded(next.recipients.filter((r) => r.role === "signer" && isPending(r)).length);
      await settle(next);
    },
  });
  const completed = envelope.status === "completed";
  const download = useMutation({
    mutationFn: async () => {
      const bytes = await envelopesApi.content(envelope.id);
      saveFile(new Blob([bytes], { type: "application/pdf" }), `${envelope.title}.pdf`);
    },
  });

  const facts = [
    envelope.sentAt !== null && `Sent ${formatDateTime(envelope.sentAt)}`,
    envelope.status === "sent" &&
      envelope.expiresAt !== null &&
      `expires ${formatDateTime(envelope.expiresAt)}`,
    envelope.completedAt !== null && `completed ${formatDateTime(envelope.completedAt)}`,
    envelope.orderMode === "sequential" ? "signers in order" : "signers in parallel",
  ].filter(Boolean);

  return (
    <Page title={envelope.title} lede={facts.join(" · ")}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <aside aria-label="Envelope actions" className="flex flex-col gap-6 lg:col-start-2">
          <Sheet folded>
            <SheetHeader>
              <SheetTitle>Status</SheetTitle>
              <div>
                <EnvelopeStatusBadge status={envelope.status} />
              </div>
            </SheetHeader>
            <SheetBody className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-3">
                <Button
                  variant={completed ? "primary" : "secondary"}
                  loading={download.isPending}
                  onClick={() => {
                    download.mutate();
                  }}
                >
                  {completed ? "Download signed PDF" : "Download PDF"}
                </Button>
                {canWrite && envelope.status === "sent" && (
                  <Button
                    variant="secondary"
                    loading={remind.isPending}
                    onClick={() => {
                      remind.mutate();
                    }}
                  >
                    Remind
                  </Button>
                )}
              </div>
              <p
                role="status"
                className="text-sm text-muted-foreground"
                data-testid="remind-result"
              >
                {reminded === null
                  ? ""
                  : `Reminder sent with a fresh link to ${reminded === 1 ? "1 signer" : `${String(reminded)} signers`}. Earlier links no longer work.`}
              </p>
              {canWrite && envelope.status === "sent" && (
                <VoidEnvelope id={envelope.id} onVoided={settle} />
              )}
              {[remind, download].map(
                (m, i) =>
                  m.isError && (
                    <p key={i} role="alert" className="text-sm font-medium text-destructive">
                      {errorMessage(m.error)}
                    </p>
                  ),
              )}
              <Link to={`/documents/${envelope.documentId}`} className="text-sm">
                Open the document (version {envelope.version})
              </Link>
            </SheetBody>
          </Sheet>
        </aside>
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-1">
          <Recipients recipients={recipients} />
          <AuditTrail detail={detail} />
        </div>
      </div>
    </Page>
  );
}

const isPending = (r: RecipientInfo) => r.status === "sent" || r.status === "viewed";

function Recipients({ recipients }: { readonly recipients: readonly RecipientInfo[] }) {
  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle>Recipients</SheetTitle>
      </SheetHeader>
      <SheetBody>
        <ol className="flex flex-col gap-4" data-testid="status-recipients">
          {recipients.map((r, i) => {
            const times = [
              r.notifiedAt !== null && `Emailed ${formatDateTime(r.notifiedAt)}`,
              r.viewedAt !== null && `Opened ${formatDateTime(r.viewedAt)}`,
              r.signedAt !== null && `Signed ${formatDateTime(r.signedAt)}`,
              r.declinedAt !== null && `Declined ${formatDateTime(r.declinedAt)}`,
            ].filter(Boolean);
            return (
              <li
                key={r.id}
                data-testid="status-recipient"
                className="flex flex-col gap-1 border-b pb-4 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <InkChip index={i} />
                  <span className="font-semibold">{r.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {r.role === "cc" ? "CC" : `Signer ${String(r.routingOrder)}`}
                  </span>
                  <RecipientStatusBadge status={r.status} />
                </div>
                <p className="break-all text-sm text-muted-foreground">{r.email}</p>
                {times.length > 0 && (
                  <p className="tabular text-sm text-muted-foreground">{times.join(" · ")}</p>
                )}
                {r.declineReason && <p className="text-sm">Reason: {r.declineReason}</p>}
              </li>
            );
          })}
        </ol>
      </SheetBody>
    </Sheet>
  );
}

function AuditTrail({ detail }: { readonly detail: EnvelopeResponse }) {
  const { envelope, recipients } = detail;
  const me = useMe();
  const audit = useQuery({
    queryKey: [...envelopeKeys.audit(envelope.id), envelope.updatedAt],
    queryFn: () => envelopesApi.audit(envelope.id),
  });
  const actorName = (actor: string) =>
    actor === "system"
      ? "Inkly"
      : actor === me?.user.id
        ? "You"
        : (recipients.find((r) => r.id === actor)?.name ?? "A member");
  const detailText = (d: Record<string, unknown>) =>
    [typeof d.email === "string" && d.email, typeof d.reason === "string" && `“${d.reason}”`]
      .filter(Boolean)
      .join(" · ");

  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle>Audit trail</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Each event carries the hash of the one before it, so any later change breaks the chain.
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        {audit.isError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errorMessage(audit.error)}
          </p>
        )}
        {audit.data &&
          (audit.data.chain.valid ? (
            <div>
              <Badge variant="success" data-testid="audit-verified">
                Audit trail verified
              </Badge>
            </div>
          ) : (
            <div role="alert" className="flex flex-col gap-1" data-testid="audit-broken">
              <div>
                <Badge variant="danger">Audit trail does not verify</Badge>
              </div>
              <p className="text-sm font-medium text-destructive">
                An event was changed after it was recorded. Do not rely on this envelope; contact
                support.
              </p>
            </div>
          ))}
        <ol className="flex flex-col gap-3" data-testid="audit-events">
          {(audit.data?.events ?? []).map((e) => {
            const extra = detailText(e.detail);
            return (
              <li key={e.seq} className="flex flex-col gap-0.5 border-b pb-3 last:border-b-0">
                <span className="font-medium">
                  {ACTION_LABEL[e.action] ?? e.action}
                  <span className="font-normal text-muted-foreground"> · {actorName(e.actor)}</span>
                </span>
                {extra && <span className="break-all text-sm">{extra}</span>}
                <span className="tabular text-sm text-muted-foreground">
                  {formatDateTime(e.at)}
                  {e.ip ? ` · ${e.ip}` : ""} ·{" "}
                  <span className="font-mono">#{e.hash.slice(0, 12)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </SheetBody>
    </Sheet>
  );
}

function VoidEnvelope({
  id,
  onVoided,
}: {
  readonly id: string;
  readonly onVoided: (next: EnvelopeResponse) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const voidIt = useMutation({
    mutationFn: () => envelopesApi.void(id, reason),
    onSuccess: async (next) => {
      dialog.current?.close();
      await onVoided(next);
    },
  });

  function submit(e: SyntheticEvent) {
    e.preventDefault();
    const parsed = EnvelopeVoid.safeParse({ reason });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Say why you are voiding it");
      return;
    }
    setInvalid(null);
    voidIt.mutate();
  }

  return (
    <>
      <Button
        ref={opener}
        variant="destructive"
        className="self-start"
        onClick={() => dialog.current?.showModal()}
      >
        Void
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => opener.current?.focus()}
        className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-md border bg-card p-0 text-card-foreground shadow-sheet backdrop:bg-foreground/40"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-4 p-6">
          <h2 id={titleId} className="text-2xl">
            Void this envelope?
          </h2>
          <p className="text-muted-foreground">
            Signing links stop working and pending signers get an email with your reason. This
            cannot be undone.
          </p>
          <Field
            label="Reason"
            value={reason}
            required
            maxLength={500}
            onChange={(e) => {
              setReason(e.currentTarget.value);
            }}
            {...(invalid ? { error: invalid } : {})}
          />
          {voidIt.isError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorMessage(voidIt.error)}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="destructive" loading={voidIt.isPending}>
              Void envelope
            </Button>
            <Button variant="secondary" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
