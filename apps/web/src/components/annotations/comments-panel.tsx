import { ANNOTATION_COLORS, type Annotation, type AnnotationColor } from "@inkly/domain";
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type SyntheticEvent } from "react";

import { ApiError } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { formatDateTime } from "../../lib/format.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../ui/sheet.tsx";
import { COLOR_LABEL, colorVar, KIND_LABEL, useAnnotationsState, type Tool } from "./context.tsx";

const TOOLS: readonly { tool: Tool; label: string }[] = [
  { tool: "select", label: "Select" },
  { tool: "highlight", label: "Highlight" },
  { tool: "note", label: "Note" },
  { tool: "ink", label: "Ink" },
];

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

function Failure({ error }: { readonly error: unknown }) {
  return error ? (
    <p role="alert" className="text-sm font-medium text-destructive">
      {errorText(error)}
    </p>
  ) : null;
}

function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

function TextArea({
  label,
  value,
  onChange,
  maxLength,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength: number;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        rows={2}
        maxLength={maxLength}
        onChange={(e) => {
          onChange(e.currentTarget.value);
        }}
        className="rounded-md border border-input bg-card px-3 py-2 text-base text-card-foreground"
      />
    </div>
  );
}

/** Presence, drawing tools, every Annotation's Comment thread and the annotated download. */
export function CommentsPanel() {
  const state = useAnnotationsState();
  const { doc, annotations, members, meId, canWrite, available } = state;
  const others = members.filter((m) => m.id !== meId);
  const download = useMutation({
    mutationFn: async () => {
      saveFile(await state.api.annotatedPdf(), `${doc.title} (annotated).pdf`);
    },
  });

  if (!available) {
    return (
      <Sheet>
        <SheetHeader>
          <SheetTitle className="text-xl">Comments</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <p className="text-sm text-muted-foreground">
            Annotations and comments come back when this document is restored from Trash.
          </p>
        </SheetBody>
      </Sheet>
    );
  }

  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Comments</SheetTitle>
        <p data-testid="presence" className="text-sm text-muted-foreground" aria-live="polite">
          {others.length === 0
            ? "Only you have this document open."
            : `Also here: ${others.map((m) => m.name).join(", ")}`}
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-5">
        {canWrite ? (
          <Tools />
        ) : (
          <p className="text-sm text-muted-foreground">
            You can read annotations. Viewers cannot add them.
          </p>
        )}
        {state.pendingNote && <NewNote />}
        {annotations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No annotations yet.{canWrite && " Pick a tool, then mark up a page."}
          </p>
        ) : (
          <ol className="flex flex-col gap-3" aria-label="Annotations">
            {annotations.map((a) => (
              <Thread key={a.id} annotation={a} />
            ))}
          </ol>
        )}
        <Button
          variant="secondary"
          loading={download.isPending}
          onClick={() => {
            download.mutate();
          }}
        >
          Download with annotations
        </Button>
        <Failure error={download.error} />
      </SheetBody>
    </Sheet>
  );
}

function Tools() {
  const { tool, setTool, color, setColor } = useAnnotationsState();
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Annotation tool" className="flex flex-wrap gap-2">
        {TOOLS.map((t) => (
          <Button
            key={t.tool}
            size="sm"
            variant={tool === t.tool ? "primary" : "secondary"}
            aria-pressed={tool === t.tool}
            onClick={() => {
              setTool(t.tool);
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>
      <ColorPicker value={color} onChange={setColor} legend="Color" />
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
  legend,
}: {
  readonly value: AnnotationColor;
  readonly onChange: (color: AnnotationColor) => void;
  readonly legend: string;
}) {
  const name = useId();
  return (
    <fieldset className="flex flex-wrap items-center gap-3">
      <legend className="mb-1 text-sm font-semibold">{legend}</legend>
      {ANNOTATION_COLORS.map((c) => (
        <label key={c} className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name={name}
            value={c}
            checked={value === c}
            onChange={() => {
              onChange(c);
            }}
          />
          <span
            aria-hidden="true"
            className="size-3.5 rounded-full border border-foreground"
            style={{ backgroundColor: colorVar(c) }}
          />
          {COLOR_LABEL[c]}
        </label>
      ))}
    </fieldset>
  );
}

function NewNote() {
  const { pendingNote, setPendingNote, color, api, select } = useAnnotationsState();
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.create({
        kind: "note",
        page: pendingNote?.page ?? 1,
        at: pendingNote?.at ?? { x: 0, y: 0 },
        color,
        text: text.trim(),
      }),
    onSuccess: (a) => {
      setPendingNote(null);
      select(a.id);
    },
  });
  function submit(e: SyntheticEvent) {
    e.preventDefault();
    if (text.trim() !== "") add.mutate();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-semibold">New note on page {pendingNote?.page}</p>
      <TextArea label="Note text" value={text} onChange={setText} maxLength={2000} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={add.isPending}>
          Add note
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPendingNote(null);
          }}
        >
          Cancel
        </Button>
      </div>
      <Failure error={add.error} />
    </form>
  );
}

function Thread({ annotation: a }: { readonly annotation: Annotation }) {
  const { doc, selected, select, meId, role, canWrite } = useAnnotationsState();
  const open = selected === a.id;
  const own = a.author.id === meId;
  const label = `${KIND_LABEL[a.shape.kind]} on page ${String(a.shape.page)}`;
  return (
    <li
      data-testid="annotation-thread"
      data-annotation-id={a.id}
      className={cn("flex flex-col gap-2 rounded-md border p-3", open && "border-ring")}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex flex-col items-start gap-1 text-left"
        onClick={() => {
          select(open ? null : a.id);
          if (!open) document.getElementById(`page-${String(a.shape.page)}`)?.scrollIntoView();
        }}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 rounded-full border border-foreground"
            style={{ backgroundColor: colorVar(a.shape.color) }}
          />
          <span className="font-semibold">{label}</span>
          {a.resolvedAt !== null && <Badge variant="success">Resolved</Badge>}
        </span>
        <span className="text-sm text-muted-foreground">
          {a.author.name} · Version {a.version}
          {a.version !== doc.currentVersion && " (earlier version)"} · {formatDateTime(a.createdAt)}
        </span>
        {a.shape.kind === "note" && <span className="text-sm">{a.shape.text}</span>}
        {!open && a.comments.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {a.comments.length} {a.comments.length === 1 ? "comment" : "comments"}
          </span>
        )}
      </button>
      {open && (
        <>
          <ol className="flex flex-col gap-2" aria-label={`Comments on ${label}`}>
            {a.comments.map((c) => (
              <li key={c.id} data-testid="comment" className="border-l-2 border-rule pl-3 text-sm">
                <p>
                  <span className="font-semibold">{c.author.name}</span>{" "}
                  <span className="text-muted-foreground">{formatDateTime(c.createdAt)}</span>
                </p>
                <p className="whitespace-pre-wrap">{c.text}</p>
              </li>
            ))}
          </ol>
          {canWrite && (
            <ThreadActions
              annotation={a}
              own={own}
              canDelete={own || role === "owner" || role === "admin"}
            />
          )}
        </>
      )}
    </li>
  );
}

function ThreadActions({
  annotation: a,
  own,
  canDelete,
}: {
  readonly annotation: Annotation;
  readonly own: boolean;
  readonly canDelete: boolean;
}) {
  const { api, select } = useAnnotationsState();
  const [text, setText] = useState("");
  const [noteText, setNoteText] = useState(a.shape.kind === "note" ? a.shape.text : "");
  const comment = useMutation({
    mutationFn: () => api.comment(a.id, text.trim()),
    onSuccess: () => {
      setText("");
    },
  });
  const resolve = useMutation({ mutationFn: () => api.resolve(a.id, a.resolvedAt === null) });
  const recolor = useMutation({
    mutationFn: (color: AnnotationColor) => api.edit(a.id, { color }),
  });
  const editNote = useMutation({ mutationFn: () => api.edit(a.id, { text: noteText.trim() }) });
  const remove = useMutation({
    mutationFn: () => api.remove(a.id),
    onSuccess: () => {
      select(null);
    },
  });

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() !== "") comment.mutate();
        }}
      >
        <TextArea label="Add a comment" value={text} onChange={setText} maxLength={4000} />
        <Button type="submit" size="sm" variant="secondary" loading={comment.isPending}>
          Comment
        </Button>
        <Failure error={comment.error} />
      </form>
      <Button
        size="sm"
        variant="secondary"
        loading={resolve.isPending}
        onClick={() => {
          resolve.mutate();
        }}
      >
        {a.resolvedAt === null ? "Resolve thread" : "Reopen thread"}
      </Button>
      <Failure error={resolve.error} />
      {own && (
        <>
          <ColorPicker
            legend="Change color"
            value={a.shape.color}
            onChange={(c) => {
              recolor.mutate(c);
            }}
          />
          <Failure error={recolor.error} />
        </>
      )}
      {own && a.shape.kind === "note" && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (noteText.trim() !== "") editNote.mutate();
          }}
        >
          <TextArea label="Edit note" value={noteText} onChange={setNoteText} maxLength={2000} />
          <Button type="submit" size="sm" variant="secondary" loading={editNote.isPending}>
            Save note
          </Button>
          <Failure error={editNote.error} />
        </form>
      )}
      {canDelete && (
        <>
          <Button
            size="sm"
            variant="destructive"
            loading={remove.isPending}
            onClick={() => {
              remove.mutate();
            }}
          >
            Delete annotation
          </Button>
          <Failure error={remove.error} />
        </>
      )}
    </div>
  );
}
