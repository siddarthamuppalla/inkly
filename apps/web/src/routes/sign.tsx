import { CONSENT_TEXT, fieldFilled, signingDate, type SignerField } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { useParams } from "react-router";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import { AdoptSignature } from "../components/adopt-signature.tsx";
import { Signature } from "../components/brand/signature.tsx";
import { Wordmark } from "../components/brand/wordmark.tsx";
import { Page } from "../components/page.tsx";
import { PageCanvas, usePdf } from "../components/pdf-pages.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Field } from "../components/ui/field.tsx";
import { ApiError, errorMessage } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import {
  fieldName,
  initialsOf,
  inPageOrder,
  missingFields,
  nextField,
  submittedValues,
  type FieldValues,
} from "../lib/signing.ts";
import { signingApi } from "../lib/signing-api.ts";

// /sign/:token, for a Recipient: no app shell, no session. Step 1 shows who sent what and
// asks for a Signing code, step 2 takes the code, step 3 is the document with this signer's
// Fields on it (ADR-0006).

const envelopeKey = (token: string) => ["sign", token] as const;

type Outcome = "signed" | "declined";

export function SignRoute() {
  const { token = "" } = useParams();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const envelope = useQuery({
    queryKey: envelopeKey(token),
    queryFn: () => signingApi.envelope(token),
    retry: false,
    enabled: outcome === null,
  });
  const data = envelope.data;

  return (
    <div className="min-h-dvh" data-testid="sign-page">
      <meta name="referrer" content="no-referrer" />
      <meta name="robots" content="noindex" />
      <header className="border-b px-5 py-4">
        <Wordmark />
      </header>
      <main id="main" className="margin-rule mx-4 my-8 pl-4 md:mx-12 md:my-12 md:pl-10">
        {outcome !== null && <Done outcome={outcome} title={data?.title ?? ""} />}
        {outcome === null && envelope.isError && <Gone error={envelope.error} />}
        {outcome === null && data?.status === "signed" && (
          <Done
            outcome="signed"
            title={data.title}
            token={token}
            role={data.role}
            signedAvailable={data.signedAvailable}
          />
        )}
        {outcome === null && data?.status === "pending" && !data.verified && (
          <Verify
            token={token}
            title={data.title}
            message={data.message}
            sender={data.sender}
            recipient={data.recipient.name}
            onVerified={envelope.refetch}
          />
        )}
        {outcome === null && data?.status === "pending" && data.verified && (
          <Document
            token={token}
            title={data.title}
            sender={data.sender.name}
            recipient={data.recipient.name}
            fields={data.fields}
            onDone={setOutcome}
          />
        )}
      </main>
    </div>
  );
}

function Gone({ error }: { readonly error: unknown }) {
  const gone = error instanceof ApiError && error.status === 404;
  return (
    <Page title={gone ? "This link is no longer available" : "This link could not be opened"}>
      <p className="max-w-prose text-muted-foreground">
        {gone
          ? "If you still need to sign, ask the sender for a new link."
          : "Check your connection and reload the page."}
      </p>
    </Page>
  );
}

function Done({
  outcome,
  title,
  token = "",
  role = "signer",
  signedAvailable = false,
}: {
  readonly outcome: Outcome;
  readonly title: string;
  readonly token?: string;
  readonly role?: "signer" | "cc";
  readonly signedAvailable?: boolean;
}) {
  if (outcome === "declined") {
    return (
      <Page title="You declined to sign" lede={title}>
        <p className="max-w-prose" data-testid="sign-done">
          We let the sender know, and this envelope is now closed. You can close this page.
        </p>
      </Page>
    );
  }
  return (
    <Page title={role === "cc" || signedAvailable ? "Everyone signed" : "You signed"} lede={title}>
      <div className="flex max-w-prose flex-col gap-4" data-testid="sign-done">
        <Signature className="w-48 text-link" />
        {signedAvailable ? (
          <>
            <p>The signed PDF, with its Certificate of completion, is ready.</p>
            <a
              href={`/api/sign/${encodeURIComponent(token)}/content`}
              download={`${title}.pdf`}
              className={buttonVariants({ className: "self-start no-underline" })}
            >
              Download the signed PDF
            </a>
          </>
        ) : (
          <p>Thank you. We'll email you a copy of the signed document once everyone has signed.</p>
        )}
      </div>
    </Page>
  );
}

function Verify({
  token,
  title,
  message,
  sender,
  recipient,
  onVerified,
}: {
  readonly token: string;
  readonly title: string;
  readonly message: string;
  readonly sender: { readonly name: string; readonly email: string };
  readonly recipient: string;
  readonly onVerified: () => Promise<unknown>;
}) {
  const [code, setCode] = useState("");
  const sendCode = useMutation({ mutationFn: () => signingApi.sendCode(token) });
  const verify = useMutation({
    mutationFn: () => signingApi.verify(token, code),
    onSuccess: onVerified,
  });
  function submit(e: SyntheticEvent) {
    e.preventDefault();
    verify.mutate();
  }

  return (
    <Page title={title} lede={`${sender.name} (${sender.email}) asked you to sign this document.`}>
      <div className="flex max-w-prose flex-col gap-6">
        {message && (
          <blockquote className="border-l-2 border-rule pl-4 whitespace-pre-line">
            {message}
          </blockquote>
        )}
        {!sendCode.isSuccess ? (
          <div className="flex flex-col gap-4">
            <p>
              Hi {recipient}. To keep this document safe, we'll email a 6-digit code to the address
              this link was sent to.
            </p>
            <Button
              className="self-start"
              loading={sendCode.isPending}
              onClick={() => {
                sendCode.mutate();
              }}
            >
              Email me a code
            </Button>
            {sendCode.isError && (
              <p role="alert" className="font-medium text-destructive">
                {errorMessage(sendCode.error)}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={submit} className="flex max-w-sm flex-col gap-4">
            <p role="status">We emailed you a code. It works for 10 minutes.</p>
            <Field
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => {
                setCode(e.currentTarget.value.replace(/\D/g, ""));
              }}
              {...(verify.isError ? { error: errorMessage(verify.error) } : {})}
            />
            <div className="flex flex-wrap gap-3">
              <Button type="submit" loading={verify.isPending}>
                Continue
              </Button>
              <Button
                variant="secondary"
                loading={sendCode.isPending}
                onClick={() => {
                  sendCode.mutate();
                }}
              >
                Send a new code
              </Button>
            </div>
          </form>
        )}
      </div>
    </Page>
  );
}

function Document({
  token,
  title,
  sender,
  recipient,
  fields,
  onDone,
}: {
  readonly token: string;
  readonly title: string;
  readonly sender: string;
  readonly recipient: string;
  readonly fields: readonly SignerField[];
  readonly onDone: (outcome: Outcome) => void;
}) {
  const content = useQuery({
    queryKey: ["sign-content", token],
    queryFn: () => signingApi.content(token),
    staleTime: Infinity,
    retry: false,
  });
  const { pdf, error } = usePdf(content.data);
  const ordered = useMemo(() => inPageOrder(fields), [fields]);
  const [values, setValues] = useState<FieldValues>({});
  const [consent, setConsent] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<SignerField | null>(null);
  const [adopted, setAdopted] = useState<Partial<Record<"signature" | "initials", string>>>({});
  const [declining, setDeclining] = useState(false);
  const refs = useRef(new Map<string, HTMLElement>());
  const consentId = useId();
  const missing = missingFields(fields, values);
  const ready = missing.length === 0 && consent;

  const finish = useMutation({
    mutationFn: () => signingApi.sign(token, submittedValues(fields, values)),
    onSuccess: () => {
      onDone("signed");
    },
  });

  function set(id: string, value: string) {
    setValues((v) => ({ ...v, [id]: value }));
  }

  function goNext() {
    const next = nextField(ordered, values, current);
    if (!next) return;
    setCurrent(next.id);
    const el = refs.current.get(next.id);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  }

  function openField(field: SignerField) {
    setCurrent(field.id);
    if (field.kind !== "signature" && field.kind !== "initials") return;
    const ready = adopted[field.kind];
    if (ready && values[field.id] === undefined) set(field.id, ready);
    else setAdopting(field);
  }

  const pages = pdf ? Array.from({ length: pdf.numPages }, (_, i) => i + 1) : [];
  const left = missing.length;

  return (
    <Page title={title} lede={`From ${sender}. Fill in the fields marked for you, then finish.`}>
      <div className="flex flex-col gap-6">
        <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-3 border-b bg-background px-2 py-3">
          <Button variant="secondary" onClick={goNext} disabled={!pdf || left === 0}>
            Next field
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {left === 0
              ? "All required fields are filled in."
              : `${String(left)} required ${left === 1 ? "field" : "fields"} left`}
          </p>
        </div>
        {(content.isError || error) && (
          <p role="alert" className="font-medium text-destructive">
            This PDF could not be displayed.
          </p>
        )}
        {!pdf && !content.isError && !error && (
          <p role="status" className="text-muted-foreground">
            Loading pages…
          </p>
        )}
        {pdf &&
          pages.map((n) => (
            <SignPage
              key={n}
              pdf={pdf}
              pageNumber={n}
              pageCount={pages.length}
              fields={ordered.filter((f) => f.page === n)}
              ordered={ordered}
              values={values}
              current={current}
              refs={refs.current}
              onOpen={openField}
              onChange={set}
            />
          ))}

        <section
          aria-labelledby={`${consentId}-h`}
          className="flex max-w-prose flex-col gap-4 border-t pt-6"
        >
          <h2 id={`${consentId}-h`} className="text-2xl">
            Finish
          </h2>
          <div className="flex items-start gap-3">
            <input
              id={consentId}
              type="checkbox"
              checked={consent}
              onChange={(e) => {
                setConsent(e.currentTarget.checked);
              }}
              className="mt-1 size-5 shrink-0 accent-seal"
            />
            <label htmlFor={consentId}>{CONSENT_TEXT}</label>
          </div>
          {finish.isError && (
            <p role="alert" className="font-medium text-destructive">
              {errorMessage(finish.error)}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={!ready}
              loading={finish.isPending}
              onClick={() => {
                finish.mutate();
              }}
            >
              Finish
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDeclining(true);
              }}
            >
              Decline to sign
            </Button>
          </div>
        </section>
      </div>
      <AdoptSignature
        open={adopting !== null}
        kind={adopting?.kind === "initials" ? "initials" : "signature"}
        defaultText={adopting?.kind === "initials" ? initialsOf(recipient) : recipient}
        onAdopt={(png) => {
          if (!adopting) return;
          const kind = adopting.kind === "initials" ? "initials" : "signature";
          setAdopted((a) => ({ ...a, [kind]: png }));
          set(adopting.id, png);
          setAdopting(null);
        }}
        onClose={() => {
          setAdopting(null);
        }}
      />
      <Decline
        token={token}
        open={declining}
        onClose={() => {
          setDeclining(false);
        }}
        onDeclined={() => {
          onDone("declined");
        }}
      />
    </Page>
  );
}

function SignPage({
  pdf,
  pageNumber,
  pageCount,
  fields,
  ordered,
  values,
  current,
  refs,
  onOpen,
  onChange,
}: {
  readonly pdf: PDFDocumentProxy;
  readonly pageNumber: number;
  readonly pageCount: number;
  readonly fields: readonly SignerField[];
  readonly ordered: readonly SignerField[];
  readonly values: FieldValues;
  readonly current: string | null;
  readonly refs: Map<string, HTMLElement>;
  readonly onOpen: (field: SignerField) => void;
  readonly onChange: (id: string, value: string) => void;
}) {
  const today = signingDate(Date.now());
  return (
    <figure className="flex flex-col gap-2">
      <div className="relative w-full max-w-[800px]">
        <PageCanvas
          pdf={pdf}
          pageNumber={pageNumber}
          width={800}
          label={`Page ${String(pageNumber)} of ${String(pageCount)}`}
          testId="page"
          className="block h-auto w-full border bg-card shadow-sheet"
        />
        {fields.map((field) => {
          const name = fieldName(field, ordered);
          const value = values[field.id];
          const filled = fieldFilled(field.kind, value);
          const style = {
            left: `${String(field.rect.x * 100)}%`,
            top: `${String(field.rect.y * 100)}%`,
            width: `${String(field.rect.w * 100)}%`,
            height: `${String(field.rect.h * 100)}%`,
          };
          const frame = cn(
            "absolute flex items-center justify-center overflow-hidden rounded-sm border-2 text-xs",
            filled ? "border-link border-solid" : "border-seal border-dashed",
            current === field.id && "ring-2 ring-ring ring-offset-1",
          );
          const keep = (el: HTMLElement | null) => {
            if (el) refs.set(field.id, el);
            else refs.delete(field.id);
          };
          if (field.kind === "signature" || field.kind === "initials") {
            return (
              <button
                key={field.id}
                ref={keep}
                type="button"
                style={style}
                data-testid="sign-field"
                data-kind={field.kind}
                aria-label={filled ? `${name}: signed. Change it` : name}
                className={cn(frame, filled ? "bg-transparent" : "bg-card font-semibold text-seal")}
                onClick={() => {
                  onOpen(field);
                }}
              >
                {filled ? (
                  <img src={value} alt="" className="h-full w-full object-contain" />
                ) : field.kind === "signature" ? (
                  "Sign here"
                ) : (
                  "Initial"
                )}
              </button>
            );
          }
          if (field.kind === "date") {
            return (
              <span
                key={field.id}
                style={style}
                data-testid="sign-field"
                data-kind="date"
                className={cn(frame, "border-link border-solid bg-card text-card-foreground")}
              >
                <span className="sr-only">{name}, filled in when you finish: </span>
                {today}
              </span>
            );
          }
          if (field.kind === "checkbox") {
            return (
              <span key={field.id} style={style} className={cn(frame, "bg-card")}>
                <input
                  ref={keep}
                  type="checkbox"
                  aria-label={name}
                  data-testid="sign-field"
                  data-kind="checkbox"
                  checked={value === "true"}
                  onFocus={() => {
                    onOpen(field);
                  }}
                  onChange={(e) => {
                    onChange(field.id, e.currentTarget.checked ? "true" : "false");
                  }}
                  className="size-4 accent-seal"
                />
              </span>
            );
          }
          return (
            <input
              key={field.id}
              ref={keep}
              type="text"
              style={style}
              maxLength={500}
              aria-label={name}
              data-testid="sign-field"
              data-kind="text"
              value={value ?? ""}
              onFocus={() => {
                onOpen(field);
              }}
              onChange={(e) => {
                onChange(field.id, e.currentTarget.value);
              }}
              className={cn(frame, "bg-card px-1 text-card-foreground")}
            />
          );
        })}
      </div>
      <figcaption className="text-sm text-muted-foreground">
        Page {pageNumber} of {pageCount}
      </figcaption>
    </figure>
  );
}

function Decline({
  token,
  open,
  onClose,
  onDeclined,
}: {
  readonly token: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDeclined: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const decline = useMutation({
    mutationFn: () => signingApi.decline(token, reason.trim()),
    onSuccess: onDeclined,
  });
  useEffect(() => {
    const el = dialog.current;
    if (open && el && !el.open) el.showModal();
  }, [open]);

  function submit(e: SyntheticEvent) {
    e.preventDefault();
    decline.mutate();
  }

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border bg-card p-0 text-card-foreground shadow-sheet backdrop:bg-foreground/40"
    >
      <form onSubmit={submit} className="flex flex-col gap-4 p-5 sm:p-6">
        <h2 id={titleId} className="text-2xl">
          Decline to sign?
        </h2>
        <p className="text-sm text-muted-foreground">
          The envelope closes for everyone and the sender sees your reason.
        </p>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={reasonId} className="text-sm font-semibold">
            Reason
            <span className="text-seal" aria-hidden="true">
              {" "}
              *
            </span>
          </label>
          <textarea
            id={reasonId}
            required
            maxLength={500}
            rows={3}
            value={reason}
            onChange={(e) => {
              setReason(e.currentTarget.value);
            }}
            className="rounded-md border border-input bg-card px-3 py-2 text-base text-card-foreground"
          />
        </div>
        {decline.isError && (
          <p role="alert" className="font-medium text-destructive">
            {errorMessage(decline.error)}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            variant="destructive"
            disabled={reason.trim() === ""}
            loading={decline.isPending}
          >
            Decline
          </Button>
          <Button variant="secondary" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  );
}
