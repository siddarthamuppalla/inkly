import type { DocumentInfo, FolderInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type DragEvent, type SyntheticEvent } from "react";
import { Link, useSearchParams } from "react-router";

import { Page } from "../components/page.tsx";
import { SignedOut } from "../components/signed-out.tsx";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Field } from "../components/ui/field.tsx";
import { UploadButton, UploadStatus, useUpload } from "../components/upload.tsx";
import { api, ApiError } from "../lib/api.ts";
import { cn } from "../lib/cn.ts";
import { folderPath } from "../lib/folders.ts";
import { formatBytes, formatDateTime, formatPages } from "../lib/format.ts";
import { keys, refreshAll, useFolders, useSignedIn } from "../lib/queries.ts";

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Try again.";
}

export function DocumentsRoute() {
  const signedIn = useSignedIn();
  const [params] = useSearchParams();
  const folderId = params.get("folder");
  return (
    <Page title="Documents" lede="Every PDF in this workspace, newest first.">
      {signedIn === false && <SignedOut />}
      {signedIn === true && <Workspace folderId={folderId} />}
    </Page>
  );
}

function Workspace({ folderId }: { readonly folderId: string | null }) {
  const folders = useFolders(true);
  const documents = useQuery({
    queryKey: keys.documents(folderId),
    queryFn: () => api.documents(folderId),
  });
  const { state, upload } = useUpload({ folderId });
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);

  const all = folders.data ?? [];
  const path = folderPath(all, folderId);
  const children = all.filter((f) => f.parentId === folderId);
  const docs = documents.data ?? [];
  const loaded = folders.isSuccess && documents.isSuccess;

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files].filter(
      (f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"),
    );
    if (files.length > 0) void upload(files);
  }

  return (
    <div className="flex flex-col gap-6">
      <FolderPath path={path} />
      <div className="flex flex-wrap items-center gap-3">
        <UploadButton multiple busy={state.kind === "uploading"} onFiles={(f) => void upload(f)}>
          Upload PDF
        </UploadButton>
        <Button
          variant="secondary"
          onClick={() => {
            setCreating(true);
          }}
          disabled={creating}
        >
          New folder
        </Button>
        <Link to="/trash" className={buttonVariants({ variant: "ghost" })}>
          Trash
        </Link>
      </div>
      <UploadStatus state={state} />
      {creating && (
        <NewFolderForm
          parentId={folderId}
          onClose={() => {
            setCreating(false);
          }}
        />
      )}

      <div
        data-testid="drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={onDrop}
        className={cn(
          "rounded-md border border-dashed border-transparent",
          dragging && "border-link bg-accent",
        )}
      >
        {documents.isError && (
          <p role="alert" className="font-medium text-destructive">
            {errorText(documents.error)}
          </p>
        )}
        {loaded && children.length === 0 && docs.length === 0 ? (
          <EmptyState title={folderId ? "This folder is empty" : "No documents yet"}>
            <p>
              Upload a PDF, or drop one here. From a document you can view every page, download it,
              rename it, move it into a folder and restore an earlier version.
            </p>
          </EmptyState>
        ) : (
          loaded && <Listing folders={children} documents={docs} />
        )}
        {dragging && <p className="p-4 text-link">Drop PDFs to upload them here.</p>}
      </div>
    </div>
  );
}

function FolderPath({ path }: { readonly path: readonly FolderInfo[] }) {
  if (path.length === 0) return null;
  return (
    <nav aria-label="Folder path">
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        <li>
          <Link to="/">All documents</Link>
        </li>
        {path.map((f, i) => (
          <li key={f.id} className="flex items-center gap-2">
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            {i === path.length - 1 ? (
              <span aria-current="page" className="font-semibold">
                {f.name}
              </span>
            ) : (
              <Link to={`/?folder=${f.id}`}>{f.name}</Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function NewFolderForm({
  parentId,
  onClose,
}: {
  readonly parentId: string | null;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.createFolder(name.trim(), parentId),
    onSuccess: async () => {
      await refreshAll();
      onClose();
    },
  });
  function submit(e: SyntheticEvent) {
    e.preventDefault();
    if (name.trim() !== "") create.mutate();
  }
  return (
    <form onSubmit={submit} className="flex max-w-md flex-wrap items-end gap-3">
      <Field
        label="Folder name"
        value={name}
        onChange={(e) => {
          setName(e.currentTarget.value);
        }}
        autoFocus
        required
        className="grow"
        {...(create.isError ? { error: errorText(create.error) } : {})}
      />
      <Button type="submit" loading={create.isPending}>
        Create folder
      </Button>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
}

function Listing({
  folders,
  documents,
}: {
  readonly folders: readonly FolderInfo[];
  readonly documents: readonly DocumentInfo[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Folders and documents</caption>
        <thead>
          <tr className="border-b text-sm text-muted-foreground">
            <th scope="col" className="py-2 pr-4 font-semibold">
              Name
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Pages
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Size
            </th>
            <th scope="col" className="py-2 pr-4 font-semibold">
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((f) => (
            <FolderRow key={f.id} folder={f} />
          ))}
          {documents.map((d) => (
            <tr key={d.id} className="border-b" data-testid="document-row">
              <th scope="row" className="py-3 pr-4 font-normal">
                <Link to={`/documents/${d.id}`} className="font-medium">
                  {d.title}
                </Link>
              </th>
              <td className="tabular py-3 pr-4">{formatPages(d.pages)}</td>
              <td className="tabular py-3 pr-4">{formatBytes(d.bytes)}</td>
              <td className="tabular py-3 pr-4">{formatDateTime(d.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FolderRow({ folder }: { readonly folder: FolderInfo }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const rename = useMutation({
    mutationFn: () => api.renameFolder(folder.id, name.trim()),
    onSuccess: async () => {
      await refreshAll();
      setRenaming(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteFolder(folder.id),
    onSuccess: refreshAll,
  });
  const failure = rename.error ?? remove.error;

  return (
    <tr className="border-b" data-testid="folder-row">
      <th scope="row" className="py-3 pr-4 font-normal" colSpan={renaming ? 4 : 1}>
        {renaming ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() !== "") rename.mutate();
            }}
          >
            <Field
              label={`New name for ${folder.name}`}
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
              }}
              autoFocus
              required
            />
            <Button type="submit" size="sm" loading={rename.isPending}>
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRenaming(false);
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to={`/?folder=${folder.id}`} className="font-medium">
              <span aria-hidden="true">▸ </span>
              {folder.name}
              <span className="sr-only"> (folder)</span>
            </Link>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Rename folder ${folder.name}`}
              onClick={() => {
                setRenaming(true);
              }}
            >
              Rename
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete folder ${folder.name}`}
              loading={remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              Delete
            </Button>
          </div>
        )}
        {failure && (
          <p role="alert" className="mt-1 text-sm font-medium text-destructive">
            {errorText(failure)}
          </p>
        )}
      </th>
      {!renaming && (
        <>
          <td className="py-3 pr-4 text-muted-foreground">Folder</td>
          <td className="py-3 pr-4" />
          <td className="tabular py-3 pr-4">{formatDateTime(folder.createdAt)}</td>
        </>
      )}
    </tr>
  );
}
