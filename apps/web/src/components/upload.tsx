import type { DocumentInfo } from "@inkly/domain";
import { useRef, useState, type ReactNode } from "react";

import { ApiError, uploadPdf } from "../lib/api.ts";
import { refreshAll } from "../lib/queries.ts";
import { Button, type ButtonProps } from "./ui/button.tsx";

type Target = { folderId: string | null } | { documentId: string };

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading"; name: string; fraction: number }
  | { kind: "failed"; name: string; message: string };

/** Uploads files one after another and exposes progress for a status line. */
export function useUpload(target: Target, onDone?: (doc: DocumentInfo) => void) {
  const [state, setState] = useState<UploadState>({ kind: "idle" });

  async function upload(files: readonly File[]) {
    for (const file of files) {
      setState({ kind: "uploading", name: file.name, fraction: 0 });
      try {
        const doc = await uploadPdf(file, target, (fraction) => {
          setState({ kind: "uploading", name: file.name, fraction });
        });
        onDone?.(doc);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "The upload failed.";
        setState({ kind: "failed", name: file.name, message });
        await refreshAll();
        return;
      }
    }
    setState({ kind: "idle" });
    await refreshAll();
  }

  return { state, upload };
}

/** A live region that announces upload progress and failures. */
export function UploadStatus({ state }: { readonly state: UploadState }) {
  const percent = state.kind === "uploading" ? Math.round(state.fraction * 100) : 0;
  return (
    <div role="status" className="flex max-w-md flex-col gap-1.5 empty:hidden">
      {state.kind === "uploading" && (
        <>
          <p className="text-sm text-muted-foreground">
            Uploading {state.name}… {percent}%
          </p>
          <progress
            aria-label={`Uploading ${state.name}`}
            max={100}
            value={percent}
            className="h-2 w-full accent-link"
          />
        </>
      )}
      {state.kind === "failed" && (
        <p className="text-sm font-medium text-destructive">
          {state.name} was not uploaded. {state.message}
        </p>
      )}
    </div>
  );
}

/** A button that opens the file picker for PDFs. */
export function UploadButton({
  onFiles,
  busy,
  multiple = false,
  children,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  readonly onFiles: (files: File[]) => void;
  readonly busy: boolean;
  readonly multiple?: boolean;
  readonly children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple={multiple}
        hidden
        data-testid="upload-input"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
      <Button {...props} loading={busy} onClick={() => input.current?.click()}>
        {children}
      </Button>
    </>
  );
}
