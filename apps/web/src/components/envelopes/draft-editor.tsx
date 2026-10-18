import {
  ENVELOPE_EXPIRY_DAYS,
  FIELD_KINDS,
  type EnvelopeResponse,
  type FieldKind,
  type OrderMode,
  type Rect,
} from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { errorMessage } from "../../lib/api.ts";
import {
  draftProblem,
  fromResponse,
  KIND_LABEL,
  newId,
  OPTIONAL_KINDS,
  saveProblem,
  toBody,
  type Draft,
  type DraftField,
} from "../../lib/envelope-draft.ts";
import { envelopeKeys, envelopesApi } from "../../lib/envelopes-api.ts";
import { queryClient, refreshAll } from "../../lib/queries.ts";
import { Page } from "../page.tsx";
import { PageCanvas, usePdf } from "../pdf-pages.tsx";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { SelectField } from "../ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../ui/sheet.tsx";
import { FIELD_DRAG_TYPE, FieldLayer } from "./field-layer.tsx";
import { InkChip, RecipientsPanel } from "./recipients-panel.tsx";

const SAVE_DELAY_MS = 600;
const EXPIRY_CHOICES = [1, 3, 7, 14, 30, 60, ENVELOPE_EXPIRY_DAYS.max];

type SaveState =
  | { readonly kind: "saved" | "saving" | "pending" }
  | { readonly kind: "invalid" | "failed"; readonly message: string };

const serialize = (d: Draft) => JSON.stringify(toBody(d));

/**
 * Saves the whole draft (PUT) a moment after each change, one request at a time. `flush`
 * saves now and resolves true once the server holds the latest draft.
 */
function useAutosave(id: string, draft: Draft) {
  const [state, setState] = useState<SaveState>({ kind: "saved" });
  const latest = useRef(draft);
  const saved = useRef(serialize(draft));
  const inFlight = useRef<Promise<unknown> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    while (inFlight.current) await inFlight.current;
    const d = latest.current;
    const body = serialize(d);
    if (body === saved.current) {
      setState({ kind: "saved" });
      return true;
    }
    const problem = saveProblem(d);
    if (problem) {
      setState({ kind: "invalid", message: problem });
      return false;
    }
    setState({ kind: "saving" });
    const request = envelopesApi.save(id, d).then(
      (res) => {
        saved.current = body;
        queryClient.setQueryData(envelopeKeys.envelope(id), res);
        return true;
      },
      (err: unknown) => {
        setState({ kind: "failed", message: errorMessage(err) });
        return false;
      },
    );
    inFlight.current = request;
    const ok = await request;
    inFlight.current = null;
    if (!ok) return false;
    if (serialize(latest.current) !== saved.current) return flush();
    setState({ kind: "saved" });
    return true;
  }, [id]);

  useEffect(() => {
    latest.current = draft;
    if (serialize(draft) === saved.current) return;
    setState({ kind: "pending" });
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    return () => {
      clearTimeout(timer.current);
    };
  }, [draft, flush]);

  // Leaving the editor saves what the timer had not yet sent.
  useEffect(
    () => () => {
      if (serialize(latest.current) !== saved.current) void flush();
    },
    [flush],
  );

  /** Stops saving: the draft is about to be deleted. */
  const discard = useCallback(() => {
    clearTimeout(timer.current);
    saved.current = serialize(latest.current);
  }, []);

  return { state, flush, discard };
}

function SaveIndicator({ state }: { readonly state: SaveState }) {
  const text =
    "message" in state
      ? `Not saved: ${state.message}`
      : { saved: "Saved", saving: "Saving…", pending: "Unsaved changes" }[state.kind];
  return (
    <p
      role="status"
      data-testid="save-state"
      className={
        state.kind === "invalid" || state.kind === "failed"
          ? "text-sm font-medium text-destructive"
          : "text-sm text-muted-foreground"
      }
    >
      {text}
    </p>
  );
}

export function DraftEditor({ detail }: { readonly detail: EnvelopeResponse }) {
  const id = detail.envelope.id;
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => fromResponse(detail));
  const { state, flush, discard } = useAutosave(id, draft);
  const content = useQuery({
    queryKey: envelopeKeys.content(id),
    queryFn: () => envelopesApi.content(id),
    staleTime: Infinity,
  });
  const { pdf, error } = usePdf(content.data);
  const pages = pdf ? Array.from({ length: pdf.numPages }, (_, i) => i + 1) : [];
  const signers = draft.recipients.filter((r) => r.role === "signer");
  const [placingFor, setPlacingFor] = useState<string | null>(signers[0]?.id ?? null);
  const owner = signers.find((r) => r.id === placingFor) ?? signers[0] ?? null;
  const [armed, setArmed] = useState<FieldKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const problem = pdf ? draftProblem(draft, pdf.numPages) : null;
  const selectedField = draft.fields.find((f) => f.id === selected) ?? null;

  const change = (next: (d: Draft) => Draft) => {
    setDraft(next);
  };
  const editField = (fieldId: string, patch: Partial<DraftField>) => {
    change((d) => ({
      ...d,
      fields: d.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)),
    }));
  };
  const removeField = (fieldId: string) => {
    change((d) => ({ ...d, fields: d.fields.filter((f) => f.id !== fieldId) }));
    setSelected(null);
  };
  const place = (kind: FieldKind, page: number, rect: Rect) => {
    if (!owner) return;
    const field = { id: newId("fld"), recipientId: owner.id, kind, page, rect, required: true };
    change((d) => ({ ...d, fields: [...d.fields, field] }));
    setSelected(field.id);
    setFocusId(field.id);
    setArmed(null);
  };

  useEffect(() => {
    if (!armed) return;
    const disarm = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmed(null);
    };
    window.addEventListener("keydown", disarm);
    return () => {
      window.removeEventListener("keydown", disarm);
    };
  }, [armed]);

  const send = useMutation({
    mutationFn: async () => {
      if (!(await flush())) throw new Error("Save the draft before sending it.");
      return envelopesApi.send(id);
    },
    onSuccess: async (sent) => {
      queryClient.setQueryData(envelopeKeys.envelope(id), sent);
      await queryClient.invalidateQueries({ queryKey: envelopeKeys.all });
    },
  });

  return (
    <Page
      title={draft.title.trim() || "Untitled envelope"}
      lede="Draft · add recipients, place their fields, then send."
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <aside
          aria-label="Envelope settings"
          className="flex flex-col gap-6 lg:col-start-2 lg:row-start-1"
        >
          <Sheet>
            <SheetHeader>
              <SheetTitle>Send</SheetTitle>
              <SaveIndicator state={state} />
            </SheetHeader>
            <SheetBody className="flex flex-col gap-3">
              <p
                id={`${id}-problem`}
                data-testid="send-problem"
                className={
                  problem ? "text-sm font-medium text-destructive" : "text-sm text-success"
                }
              >
                {!pdf ? "Loading the document…" : (problem ?? "Ready to send.")}
              </p>
              <Button
                className="self-start"
                disabled={!pdf || problem !== null}
                loading={send.isPending}
                aria-describedby={`${id}-problem`}
                onClick={() => {
                  send.mutate();
                }}
              >
                Send
              </Button>
              {send.isError && (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {errorMessage(send.error)}
                </p>
              )}
            </SheetBody>
          </Sheet>
          <Settings draft={draft} onChange={change} />
          <RecipientsPanel draft={draft} onChange={change} />
          <Palette
            owner={owner}
            signers={signers}
            armed={armed}
            onArm={setArmed}
            onOwner={setPlacingFor}
            ownerIndex={owner ? draft.recipients.indexOf(owner) : 0}
          />
          {selectedField && (
            <Inspector
              field={selectedField}
              draft={draft}
              onEdit={(patch) => {
                editField(selectedField.id, patch);
              }}
              onRemove={() => {
                removeField(selectedField.id);
              }}
            />
          )}
          <DeleteDraft
            onDelete={async () => {
              discard();
              await envelopesApi.remove(id);
              await navigate("/envelopes");
              queryClient.removeQueries({ queryKey: envelopeKeys.envelope(id) });
              await refreshAll();
            }}
          />
        </aside>

        <section
          aria-label="Pages"
          className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-1"
        >
          <p className="text-muted-foreground sm:hidden" data-testid="small-screen">
            Use a larger screen to place fields. You can still edit recipients and settings here.
          </p>
          <p className="hidden text-sm text-muted-foreground sm:block">
            Pick a field, then click a page or drag the field onto it. Focus a field to move it with
            the arrow keys (Shift for bigger steps, Alt to resize) or remove it with Delete.{" "}
            <Link to={`/documents/${detail.envelope.documentId}`}>Open the document</Link>
          </p>
          {(content.isError || error) && (
            <p role="alert" className="font-medium text-destructive">
              This PDF could not be displayed.
            </p>
          )}
          {pdf && (
            <div className="hidden flex-col gap-6 sm:flex">
              {pages.map((n) => (
                <figure key={n} id={`page-${String(n)}`} className="flex flex-col gap-2">
                  <div className="relative w-full max-w-[800px]">
                    <PageCanvas
                      pdf={pdf}
                      pageNumber={n}
                      width={800}
                      label={`Page ${String(n)} of ${String(pages.length)}`}
                      testId="page"
                      className="block h-auto w-full border bg-card shadow-sheet"
                    />
                    <FieldLayer
                      page={n}
                      fields={draft.fields.filter((f) => f.page === n)}
                      recipients={draft.recipients}
                      armed={owner ? armed : null}
                      selected={selected}
                      focusId={focusId}
                      onPlace={place}
                      onChange={(fieldId, rect) => {
                        editField(fieldId, { rect });
                      }}
                      onSelect={setSelected}
                      onRemove={removeField}
                    />
                  </div>
                  <figcaption className="text-sm text-muted-foreground">
                    Page {n} of {pages.length}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      </div>
    </Page>
  );
}

function Settings({
  draft,
  onChange,
}: {
  readonly draft: Draft;
  readonly onChange: (next: (d: Draft) => Draft) => void;
}) {
  const messageId = useId();
  const expiry = [...new Set([...EXPIRY_CHOICES, draft.expiresInDays])].sort((a, b) => a - b);
  const set = (patch: Partial<Draft>) => {
    onChange((d) => ({ ...d, ...patch }));
  };
  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle>Envelope</SheetTitle>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        <Field
          label="Title"
          value={draft.title}
          required
          maxLength={200}
          onChange={(e) => {
            set({ title: e.currentTarget.value });
          }}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={messageId} className="text-sm font-semibold">
            Message to recipients
          </label>
          <textarea
            id={messageId}
            value={draft.message}
            maxLength={2000}
            rows={3}
            onChange={(e) => {
              set({ message: e.currentTarget.value });
            }}
            className="rounded-md border border-input bg-card px-3 py-2 text-base text-card-foreground"
          />
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Signing order</legend>
          {(
            [
              ["parallel", "Parallel", "Everyone can sign at once"],
              ["sequential", "Sequential", "One signer after another, in list order"],
            ] as const satisfies readonly (readonly [OrderMode, string, string])[]
          ).map(([mode, label, hint]) => (
            <label key={mode} className="flex items-start gap-2">
              <input
                type="radio"
                name="order-mode"
                value={mode}
                checked={draft.orderMode === mode}
                onChange={() => {
                  set({ orderMode: mode });
                }}
                className="mt-1 size-5 accent-primary"
              />
              <span>
                <span className="font-medium">{label}</span>
                <span className="block text-sm text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <SelectField
          label="Expires after"
          value={String(draft.expiresInDays)}
          onChange={(e) => {
            set({ expiresInDays: Number(e.currentTarget.value) });
          }}
        >
          {expiry.map((days) => (
            <option key={days} value={days}>
              {days === 1 ? "1 day" : `${String(days)} days`}
            </option>
          ))}
        </SelectField>
      </SheetBody>
    </Sheet>
  );
}

function Palette({
  owner,
  ownerIndex,
  signers,
  armed,
  onArm,
  onOwner,
}: {
  readonly owner: Draft["recipients"][number] | null;
  readonly ownerIndex: number;
  readonly signers: Draft["recipients"];
  readonly armed: FieldKind | null;
  readonly onArm: (kind: FieldKind | null) => void;
  readonly onOwner: (id: string) => void;
}) {
  return (
    <Sheet className="hidden sm:block">
      <SheetHeader>
        <SheetTitle>Fields</SheetTitle>
        <p className="text-sm text-muted-foreground">
          {owner
            ? "Pick one, then click where it goes, or drag it onto a page. Esc cancels."
            : "Add a signer to place fields."}
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        {owner && (
          <div className="flex items-end gap-2">
            <SelectField
              label="Fields for"
              className="grow"
              value={owner.id}
              onChange={(e) => {
                onOwner(e.currentTarget.value);
              }}
            >
              {signers.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {s.name.trim() || `Signer ${String(i + 1)}`}
                </option>
              ))}
            </SelectField>
            <span className="pb-3.5">
              <InkChip index={ownerIndex} />
            </span>
          </div>
        )}
        <div role="group" aria-label="Field types" className="flex flex-wrap gap-2">
          {FIELD_KINDS.map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant={armed === kind ? "primary" : "secondary"}
              aria-pressed={armed === kind}
              disabled={!owner}
              draggable={owner !== null}
              onDragStart={(e) => {
                e.dataTransfer.setData(FIELD_DRAG_TYPE, kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => {
                onArm(armed === kind ? null : kind);
              }}
            >
              {KIND_LABEL[kind]}
            </Button>
          ))}
        </div>
      </SheetBody>
    </Sheet>
  );
}

function Inspector({
  field,
  draft,
  onEdit,
  onRemove,
}: {
  readonly field: DraftField;
  readonly draft: Draft;
  readonly onEdit: (patch: Partial<DraftField>) => void;
  readonly onRemove: () => void;
}) {
  const requiredId = useId();
  const signers = draft.recipients.filter((r) => r.role === "signer");
  const owner = draft.recipients.find((r) => r.id === field.recipientId);
  return (
    <Sheet className="hidden sm:block" data-testid="field-inspector">
      <SheetHeader>
        <SheetTitle>
          {KIND_LABEL[field.kind]} on page {field.page}
        </SheetTitle>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        <SelectField
          label="Filled in by"
          value={field.recipientId}
          onChange={(e) => {
            onEdit({ recipientId: e.currentTarget.value });
          }}
        >
          {owner?.role === "cc" && <option value={owner.id}>{owner.name} (CC)</option>}
          {signers.map((s, i) => (
            <option key={s.id} value={s.id}>
              {s.name.trim() || `Signer ${String(i + 1)}`}
            </option>
          ))}
        </SelectField>
        {OPTIONAL_KINDS.has(field.kind) && (
          <div className="flex items-center gap-2">
            <input
              id={requiredId}
              type="checkbox"
              className="size-5 accent-primary"
              checked={field.required}
              onChange={(e) => {
                onEdit({ required: e.currentTarget.checked });
              }}
            />
            <label htmlFor={requiredId} className="font-semibold">
              Required
            </label>
          </div>
        )}
        <Button variant="destructive" size="sm" className="self-start" onClick={onRemove}>
          Delete field
        </Button>
      </SheetBody>
    </Sheet>
  );
}

function DeleteDraft({ onDelete }: { readonly onDelete: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const remove = useMutation({ mutationFn: onDelete });
  return (
    <>
      <Button variant="ghost" className="self-start" onClick={() => dialog.current?.showModal()}>
        Delete draft
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-md border bg-card p-0 text-card-foreground shadow-sheet backdrop:bg-foreground/40"
      >
        <div className="flex flex-col gap-4 p-6">
          <h2 id={titleId} className="text-2xl">
            Delete this draft?
          </h2>
          <p className="text-muted-foreground">
            Its recipients and fields go with it. The document stays as it is.
          </p>
          {remove.isError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorMessage(remove.error)}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              Delete draft
            </Button>
            <Button variant="secondary" autoFocus onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
          </div>
        </div>
      </dialog>
    </>
  );
}
