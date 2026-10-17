import type { DocumentInfo, VersionInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type SyntheticEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { AnnotationLayer } from "../components/annotations/annotation-layer.tsx";
import { CommentsPanel } from "../components/annotations/comments-panel.tsx";
import { AnnotationsProvider } from "../components/annotations/context.tsx";
import { CompressPanel } from "../components/compress.tsx";
import { FormPanel } from "../components/form-panel.tsx";
import { Page } from "../components/page.tsx";
import { PageEdits } from "../components/page-edits.tsx";
import { PageCanvas, usePdf } from "../components/pdf-pages.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Field } from "../components/ui/field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { UploadButton, UploadStatus, useUpload } from "../components/upload.tsx";
import { ApiError } from "../lib/api.ts";
import { documentsApi } from "../lib/documents-api.ts";
import { folderChoices, folderPath } from "../lib/folders.ts";
import { formatBytes, formatDateTime, formatPages } from "../lib/format.ts";
import { keys, refreshAll, useFolders } from "../lib/queries.ts";

/** Saves fetched bytes, so a download carries the same credentials as every API call. */
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

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

export function DocumentRoute() {
  const { id = "" } = useParams();
  const document = useQuery({
    queryKey: keys.document(id),
    queryFn: () => documentsApi.document(id),
  });

  if (document.isError) {
    return (
      <Page title="Document not found">
        <p className="max-w-prose text-muted-foreground">
          This document does not exist in your workspace, or you no longer have access to it.{" "}
          <Link to="/">Back to Documents</Link>
        </p>
      </Page>
    );
  }
  if (!document.data) return <Page title="Document">{null}</Page>;
  return (
    <AnnotationsProvider doc={document.data}>
      <Viewer doc={document.data} />
    </AnnotationsProvider>
  );
}

function Viewer({ doc }: { readonly doc: DocumentInfo }) {
  const content = useQuery({
    queryKey: keys.content(doc.id, doc.currentVersion),
    queryFn: () => documentsApi.content(doc.id),
    staleTime: Infinity,
  });
  const { pdf, error } = usePdf(content.data);
  const pages = pdf ? Array.from({ length: pdf.numPages }, (_, i) => i + 1) : [];
  const lede = `${formatPages(doc.pages)} · ${formatBytes(doc.bytes)} · Version ${String(doc.currentVersion)} · Updated ${formatDateTime(doc.updatedAt)}`;

  return (
    <Page title={doc.title} lede={lede}>
      <div className="grid gap-8 md:grid-cols-[7rem_minmax(0,1fr)] xl:grid-cols-[7rem_minmax(0,1fr)_18rem]">
        <aside
          aria-label="Document actions"
          className="flex flex-col gap-6 md:col-span-2 xl:col-span-1 xl:col-start-3 xl:row-start-1"
        >
          <Actions doc={doc} />
          <FormPanel doc={doc} />
          <PageEdits key={doc.currentVersion} doc={doc} pdf={pdf} />
          <CompressPanel doc={doc} />
          <CommentsPanel />
          <Versions doc={doc} />
        </aside>
        <nav aria-label="Page thumbnails" className="hidden md:block xl:col-start-1 xl:row-start-1">
          <ol className="sticky top-6 flex max-h-[calc(100dvh-3rem)] flex-col gap-3 overflow-y-auto p-1">
            {pdf &&
              pages.map((n) => (
                <li key={n}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-center gap-1 rounded-md p-1 text-sm text-muted-foreground hover:bg-muted"
                    onClick={() => document.getElementById(`page-${String(n)}`)?.scrollIntoView()}
                  >
                    <PageCanvas
                      pdf={pdf}
                      pageNumber={n}
                      width={88}
                      testId="thumbnail"
                      className="h-auto w-full border bg-card shadow-sheet"
                    />
                    <span>Page {n}</span>
                  </button>
                </li>
              ))}
          </ol>
        </nav>

        <section
          aria-label="Pages"
          className="flex min-w-0 flex-col gap-6 xl:col-start-2 xl:row-start-1"
        >
          {(content.isError || error) && (
            <p role="alert" className="font-medium text-destructive">
              This PDF could not be displayed. You can still download it.
            </p>
          )}
          {!pdf && !content.isError && !error && (
            <p role="status" className="text-muted-foreground">
              Loading pages…
            </p>
          )}
          {pdf &&
            pages.map((n) => (
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
                  <AnnotationLayer page={n} />
                </div>
                <figcaption className="text-sm text-muted-foreground">
                  Page {n} of {pages.length}
                </figcaption>
              </figure>
            ))}
        </section>
      </div>
    </Page>
  );
}

function Actions({ doc }: { readonly doc: DocumentInfo }) {
  const navigate = useNavigate();
  const trashed = doc.deletedAt !== null;
  const trash = useMutation({
    mutationFn: () =>
      trashed ? documentsApi.restoreDocument(doc.id) : documentsApi.trashDocument(doc.id),
    onSuccess: async () => {
      await refreshAll();
      if (!trashed) await navigate(doc.folderId ? `/?folder=${doc.folderId}` : "/");
    },
  });
  const { state, upload } = useUpload({ documentId: doc.id });
  const download = useMutation({
    mutationFn: async () => {
      const bytes = await documentsApi.content(doc.id);
      saveFile(new Blob([bytes], { type: "application/pdf" }), `${doc.title}.pdf`);
    },
  });

  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Actions</SheetTitle>
        {trashed && <Badge variant="warning">In Trash</Badge>}
      </SheetHeader>
      <SheetBody className="flex flex-col gap-5">
        <div className="flex flex-wrap gap-3">
          <Button
            loading={download.isPending}
            onClick={() => {
              download.mutate();
            }}
          >
            Download
          </Button>
          <UploadButton
            variant="secondary"
            busy={state.kind === "uploading"}
            onFiles={(f) => void upload(f)}
          >
            Upload new version
          </UploadButton>
        </div>
        <UploadStatus state={state} />
        <RenameForm doc={doc} />
        <MoveForm doc={doc} />
        <div className="flex flex-col gap-2">
          <Button
            variant={trashed ? "secondary" : "destructive"}
            loading={trash.isPending}
            onClick={() => {
              trash.mutate();
            }}
          >
            {trashed ? "Restore from Trash" : "Move to Trash"}
          </Button>
          {download.isError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorText(download.error)}
            </p>
          )}
          {trash.isError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorText(trash.error)}
            </p>
          )}
        </div>
      </SheetBody>
    </Sheet>
  );
}

function RenameForm({ doc }: { readonly doc: DocumentInfo }) {
  const [title, setTitle] = useState(doc.title);
  const rename = useMutation({
    mutationFn: () => documentsApi.updateDocument(doc.id, { title: title.trim() }),
    onSuccess: refreshAll,
  });
  function submit(e: SyntheticEvent) {
    e.preventDefault();
    if (title.trim() !== "" && title.trim() !== doc.title) rename.mutate();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Field
        label="Title"
        value={title}
        onChange={(e) => {
          setTitle(e.currentTarget.value);
        }}
        required
        maxLength={200}
        {...(rename.isError ? { error: errorText(rename.error) } : {})}
      />
      <Button type="submit" variant="secondary" size="sm" loading={rename.isPending}>
        Rename
      </Button>
    </form>
  );
}

function MoveForm({ doc }: { readonly doc: DocumentInfo }) {
  const folders = useFolders(true);
  const [target, setTarget] = useState(doc.folderId ?? "");
  const move = useMutation({
    mutationFn: () =>
      documentsApi.updateDocument(doc.id, { folderId: target === "" ? null : target }),
    onSuccess: refreshAll,
  });
  const choices = folderChoices(folders.data ?? []);
  const where = folderPath(folders.data ?? [], doc.folderId)
    .map((f) => f.name)
    .join(" / ");

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate();
      }}
    >
      <label htmlFor="move-target" className="text-sm font-semibold">
        Folder
      </label>
      <select
        id="move-target"
        aria-describedby="move-current"
        value={target}
        onChange={(e) => {
          setTarget(e.currentTarget.value);
        }}
        className="h-11 rounded-md border border-input bg-card px-3 text-base text-card-foreground"
      >
        <option value="">No folder (top level)</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <p id="move-current" className="text-sm text-muted-foreground">
        Now in: {where === "" ? "top level" : where}
      </p>
      <Button
        type="submit"
        variant="secondary"
        size="sm"
        loading={move.isPending}
        disabled={target === (doc.folderId ?? "")}
      >
        Move
      </Button>
      {move.isError && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorText(move.error)}
        </p>
      )}
    </form>
  );
}

function Versions({ doc }: { readonly doc: DocumentInfo }) {
  const versions = useQuery({
    queryKey: keys.versions(doc.id),
    queryFn: () => documentsApi.versions(doc.id),
  });
  const restore = useMutation({
    mutationFn: (n: number) => documentsApi.restoreVersion(doc.id, n),
    onSuccess: refreshAll,
  });
  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Version history</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Restoring a version adds it as a new version; nothing is overwritten.
        </p>
      </SheetHeader>
      <SheetBody>
        {restore.isError && (
          <p role="alert" className="mb-3 text-sm font-medium text-destructive">
            {errorText(restore.error)}
          </p>
        )}
        <ol className="flex flex-col gap-4" data-testid="versions">
          {(versions.data ?? []).map((v) => (
            <VersionItem
              key={v.n}
              version={v}
              current={v.n === doc.currentVersion}
              busy={restore.isPending && restore.variables === v.n}
              onRestore={() => {
                restore.mutate(v.n);
              }}
            />
          ))}
        </ol>
      </SheetBody>
    </Sheet>
  );
}

function VersionItem({
  version,
  current,
  busy,
  onRestore,
}: {
  readonly version: VersionInfo;
  readonly current: boolean;
  readonly busy: boolean;
  readonly onRestore: () => void;
}) {
  return (
    <li className="flex flex-col gap-1 border-b pb-3 last:border-b-0" data-testid="version">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Version {version.n}</span>
        {current && <Badge variant="success">Current</Badge>}
      </div>
      <p className="tabular text-sm text-muted-foreground">
        {formatPages(version.pages)} · {formatBytes(version.bytes)} ·{" "}
        {formatDateTime(version.createdAt)}
      </p>
      {!current && (
        <Button
          size="sm"
          variant="secondary"
          className="self-start"
          loading={busy}
          aria-label={`Restore version ${String(version.n)}`}
          onClick={onRestore}
        >
          Restore
        </Button>
      )}
    </li>
  );
}
