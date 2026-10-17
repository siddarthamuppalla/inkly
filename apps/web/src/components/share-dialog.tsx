import { FREE_SHARE_LINK_MAX_MS, SHARE_PASSWORD_MIN, type DocumentInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useRef, useState, type SyntheticEvent } from "react";

import { errorMessage } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";
import { refreshAll } from "../lib/queries.ts";
import { useMe } from "../lib/session.ts";
import { shareLinksApi } from "../lib/share-links-api.ts";
import { ShareLinkStatusBadge } from "./share-link-status.tsx";
import { Button } from "./ui/button.tsx";
import { Field } from "./ui/field.tsx";
import { SelectField } from "./ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "./ui/sheet.tsx";

const DAY = 24 * 60 * 60 * 1000;
const EXPIRY = [
  { value: "1", label: "1 day", ms: DAY },
  { value: "7", label: "7 days", ms: FREE_SHARE_LINK_MAX_MS },
  { value: "30", label: "30 days", ms: 30 * DAY, pro: true },
  { value: "365", label: "1 year", ms: 365 * DAY, pro: true },
  { value: "never", label: "Never", ms: null, pro: true },
] as const;

export const shareLinkKeys = {
  forDocument: (documentId: string) => ["share-links", documentId] as const,
  all: ["share-links"] as const,
};

/** The viewer's Share panel: this Document's links and a dialog to create one. */
export function SharePanel({ doc }: { readonly doc: DocumentInfo }) {
  const me = useMe();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const links = useQuery({
    queryKey: shareLinkKeys.forDocument(doc.id),
    queryFn: () => shareLinksApi.list(doc.id),
  });
  const canShare = me?.role !== "viewer" && doc.deletedAt === null;

  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Share</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Anyone with a link can open the current version, signed out.
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        {canShare && (
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              setOpen(true);
              dialog.current?.showModal();
            }}
          >
            Share with a link
          </Button>
        )}
        <ul className="flex flex-col gap-3" data-testid="document-share-links">
          {(links.data ?? []).map((link) => (
            <li key={link.id} className="flex flex-col gap-1 border-b pb-3 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                <ShareLinkStatusBadge link={link} />
                {link.hasPassword && <span className="text-sm">Password</span>}
                {!link.allowDownload && <span className="text-sm">No download</span>}
              </div>
              <p className="tabular text-sm text-muted-foreground">
                {link.expiresAt === null
                  ? "Never expires"
                  : `Expires ${formatDateTime(link.expiresAt)}`}{" "}
                · {link.opens === 1 ? "1 open" : `${String(link.opens)} opens`}
              </p>
            </li>
          ))}
        </ul>
        {links.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No links to this document yet.</p>
        )}
      </SheetBody>
      <dialog
        ref={dialog}
        aria-labelledby={`share-${doc.id}`}
        onClose={() => {
          setOpen(false);
        }}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border bg-card p-0 text-card-foreground shadow-sheet backdrop:bg-foreground/40"
      >
        {open && (
          <ShareForm
            doc={doc}
            pro={me?.activeTenant?.plan === "pro"}
            titleId={`share-${doc.id}`}
            onDone={() => dialog.current?.close()}
          />
        )}
      </dialog>
    </Sheet>
  );
}

function ShareForm({
  doc,
  pro,
  titleId,
  onDone,
}: {
  readonly doc: DocumentInfo;
  readonly pro: boolean;
  readonly titleId: string;
  readonly onDone: () => void;
}) {
  const [expiry, setExpiry] = useState("7");
  const [password, setPassword] = useState("");
  const [allowDownload, setAllowDownload] = useState(true);
  const [copied, setCopied] = useState(false);
  const downloadId = useId();
  const create = useMutation({
    mutationFn: () => {
      const choice = EXPIRY.find((e) => e.value === expiry);
      const ms = choice ? choice.ms : FREE_SHARE_LINK_MAX_MS;
      return shareLinksApi.create({
        documentId: doc.id,
        expiresAt: ms === null ? null : Date.now() + ms,
        password: pro && password !== "" ? password : null,
        allowDownload: pro ? allowDownload : true,
      });
    },
    onSuccess: refreshAll,
  });

  function submit(e: SyntheticEvent) {
    e.preventDefault();
    create.mutate();
  }

  if (create.data) {
    const url = `${window.location.origin}${create.data.url}`;
    return (
      <div className="flex flex-col gap-4 p-6">
        <h2 id={titleId} className="text-2xl">
          Link created
        </h2>
        <Field
          label="Share link"
          value={url}
          readOnly
          hint="Copy it now. Inkly stores only a fingerprint of the link, so it cannot show it again."
          onFocus={(e) => {
            e.currentTarget.select();
          }}
        />
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(url).then(() => {
                setCopied(true);
              });
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Done
          </Button>
        </div>
        <p role="status" className="sr-only">
          {copied ? "Link copied" : ""}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 p-6">
      <h2 id={titleId} className="text-2xl">
        Share {doc.title}
      </h2>
      <SelectField
        label="Link expires after"
        value={expiry}
        onChange={(e) => {
          setExpiry(e.currentTarget.value);
        }}
      >
        {EXPIRY.filter((e) => pro || !("pro" in e)).map((e) => (
          <option key={e.value} value={e.value}>
            {e.label}
          </option>
        ))}
      </SelectField>
      {pro ? (
        <>
          <Field
            label="Password (optional)"
            type="password"
            autoComplete="new-password"
            value={password}
            minLength={SHARE_PASSWORD_MIN}
            maxLength={200}
            hint={`At least ${String(SHARE_PASSWORD_MIN)} characters. Leave empty for no password.`}
            onChange={(e) => {
              setPassword(e.currentTarget.value);
            }}
          />
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                id={downloadId}
                type="checkbox"
                className="size-5 accent-primary"
                checked={allowDownload}
                aria-describedby={`${downloadId}-hint`}
                onChange={(e) => {
                  setAllowDownload(e.currentTarget.checked);
                }}
              />
              <label htmlFor={downloadId} className="font-semibold">
                Allow download
              </label>
            </div>
            <p id={`${downloadId}-hint`} className="text-sm text-muted-foreground">
              Without download, visitors can only view the PDF and see no Download button. This
              discourages copying; it cannot prevent it.
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          On the Free plan, links expire within 7 days and always allow download. Pro adds
          passwords, longer links and download control.
        </p>
      )}
      {create.isError && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage(create.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" loading={create.isPending}>
          Create link
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
