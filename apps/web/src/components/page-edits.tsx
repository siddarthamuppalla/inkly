import { parseRanges, type DocumentInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useState, type SyntheticEvent } from "react";
import { Link, useNavigate } from "react-router";

import { ApiError } from "../lib/api.ts";
import { documentsApi } from "../lib/documents-api.ts";
import { pageOpsApi } from "../lib/page-ops-api.ts";
import { keys, refreshAll } from "../lib/queries.ts";
import { PageCanvas } from "./pdf-pages.tsx";
import { Button } from "./ui/button.tsx";
import { Field } from "./ui/field.tsx";
import { SelectField } from "./ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "./ui/sheet.tsx";

// Page edits for the viewer (T1.3b). Rotate and delete act on the selected pages at once;
// reorder is arranged here and saved in one go. Each saved edit is a new Version.

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

function ErrorLine({ error }: { readonly error: unknown }) {
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      {errorText(error)}
    </p>
  );
}

/** Mount with `key={doc.currentVersion}` so a new Version starts from a clean slate. */
export function PageEdits({
  doc,
  pdf,
}: {
  readonly doc: DocumentInfo;
  readonly pdf: PDFDocumentProxy | null;
}) {
  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Edit pages</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Each edit saves a new version; earlier versions stay in the history.
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-6">
        <PageList doc={doc} pdf={pdf} />
        <SplitForm doc={doc} />
        <MergeForm doc={doc} />
      </SheetBody>
    </Sheet>
  );
}

function PageList({
  doc,
  pdf,
}: {
  readonly doc: DocumentInfo;
  readonly pdf: PDFDocumentProxy | null;
}) {
  const [order, setOrder] = useState(() => Array.from({ length: doc.pages }, (_, i) => i + 1));
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const reordered = order.some((page, i) => page !== i + 1);
  const pages = [...selected].sort((a, b) => a - b);

  const run = useMutation({
    mutationFn: (op: "left" | "right" | "delete" | "order") => {
      if (op === "order") return pageOpsApi.reorder(doc.id, { order });
      if (op === "delete") return pageOpsApi.deletePages(doc.id, { pages });
      return pageOpsApi.rotate(doc.id, { pages, degrees: op === "left" ? -90 : 90 });
    },
    onSuccess: refreshAll,
  });

  function move(index: number, by: -1 | 1) {
    const next = [...order];
    const [page] = next.splice(index, 1);
    if (page === undefined) return;
    next.splice(index + by, 0, page);
    setOrder(next);
  }

  function toggle(page: number) {
    const next = new Set(selected);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    setSelected(next);
  }

  const none = pages.length === 0;
  const busy = (op: string) => run.isPending && run.variables === op;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Edit selected pages">
        <Button
          size="sm"
          variant="secondary"
          disabled={none || reordered}
          loading={busy("left")}
          onClick={() => {
            run.mutate("left");
          }}
        >
          Rotate left
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={none || reordered}
          loading={busy("right")}
          onClick={() => {
            run.mutate("right");
          }}
        >
          Rotate right
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={none || reordered || pages.length === doc.pages}
          loading={busy("delete")}
          onClick={() => {
            run.mutate("delete");
          }}
        >
          Delete
        </Button>
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {reordered
          ? "Save the new order before rotating or deleting."
          : none
            ? "Select pages to rotate or delete."
            : `${String(pages.length)} selected`}
      </p>
      <ol className="flex max-h-96 flex-col gap-2 overflow-y-auto p-1" aria-label="Page order">
        {order.map((page, i) => (
          <li
            key={page}
            data-testid="edit-page"
            className="flex items-center gap-2 rounded-md border bg-card p-1.5"
          >
            <input
              type="checkbox"
              className="size-5 accent-primary"
              aria-label={`Select page ${String(page)}`}
              checked={selected.has(page)}
              disabled={reordered}
              onChange={() => {
                toggle(page);
              }}
            />
            {pdf && (
              <PageCanvas
                pdf={pdf}
                pageNumber={page}
                width={40}
                testId="edit-thumbnail"
                className="h-auto w-10 border bg-card"
              />
            )}
            <span className="flex-1 text-sm">Page {page}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move page ${String(page)} up`}
              disabled={i === 0}
              onClick={() => {
                move(i, -1);
              }}
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Move page ${String(page)} down`}
              disabled={i === order.length - 1}
              onClick={() => {
                move(i, 1);
              }}
            >
              ↓
            </Button>
          </li>
        ))}
      </ol>
      {reordered && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy("order")}
            onClick={() => {
              run.mutate("order");
            }}
          >
            Save order
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOrder(order.slice().sort((a, b) => a - b));
            }}
          >
            Reset
          </Button>
        </div>
      )}
      {run.isError && <ErrorLine error={run.error} />}
    </div>
  );
}

function SplitForm({ doc }: { readonly doc: DocumentInfo }) {
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const split = useMutation({
    mutationFn: (ranges: { from: number; to: number }[]) => pageOpsApi.split(doc.id, { ranges }),
    onSuccess: refreshAll,
  });
  function submit(e: SyntheticEvent) {
    e.preventDefault();
    const ranges = parseRanges(text);
    setInvalid(ranges === null);
    if (ranges) split.mutate(ranges);
  }
  const error = invalid
    ? "Write pages like 1-3, 4, 5-10"
    : split.isError
      ? errorText(split.error)
      : undefined;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Field
        label="Split into new documents"
        hint="One new document per range, e.g. 1-3, 4-10"
        placeholder="1-3, 4-10"
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
        }}
        {...(error ? { error } : {})}
      />
      <Button type="submit" variant="secondary" size="sm" loading={split.isPending}>
        Split
      </Button>
      {split.data && (
        <ul className="flex flex-col gap-1 text-sm" aria-label="New documents">
          {split.data.map((d) => (
            <li key={d.id}>
              <Link to={`/documents/${d.id}`}>{d.title}</Link>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function MergeForm({ doc }: { readonly doc: DocumentInfo }) {
  const navigate = useNavigate();
  const siblings = useQuery({
    queryKey: keys.documents(doc.folderId),
    queryFn: () => documentsApi.documents(doc.folderId),
  });
  const others = (siblings.data ?? []).filter((d) => d.id !== doc.id);
  const [other, setOther] = useState("");
  const merge = useMutation({
    mutationFn: () => pageOpsApi.merge({ documentIds: [doc.id, other] }),
    onSuccess: async (merged) => {
      await refreshAll();
      await navigate(`/documents/${merged.id}`);
    },
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (other !== "") merge.mutate();
      }}
    >
      <SelectField
        label="Merge with"
        value={other}
        onChange={(e) => {
          setOther(e.currentTarget.value);
        }}
      >
        <option value="">Choose a document in this folder</option>
        {others.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
          </option>
        ))}
      </SelectField>
      <p className="text-sm text-muted-foreground">
        Makes a new document: this one&apos;s pages, then the other&apos;s.
      </p>
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        loading={merge.isPending}
        disabled={other === ""}
      >
        Merge
      </Button>
      {merge.isError && <ErrorLine error={merge.error} />}
    </form>
  );
}
