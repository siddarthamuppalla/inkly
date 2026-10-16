import { shareLinkStatus, type ShareLinkInfo } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { ActivityList } from "../components/activity-list.tsx";
import { Page } from "../components/page.tsx";
import { shareLinkKeys } from "../components/share-dialog.tsx";
import { ShareLinkStatusBadge } from "../components/share-link-status.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { errorMessage } from "../lib/api.ts";
import { formatDateTime } from "../lib/format.ts";
import { refreshAll } from "../lib/queries.ts";
import { useMe } from "../lib/session.ts";
import { shareLinksApi } from "../lib/share-links-api.ts";

export function LinksRoute() {
  return (
    <Page title="Share links" lede="Who can open what, and until when.">
      <LinkList />
    </Page>
  );
}

const HEADINGS = ["Document", "Status", "Created", "Expires", "Opens", "Last open"] as const;

function LinkList() {
  const me = useMe();
  const links = useQuery({ queryKey: shareLinkKeys.all, queryFn: () => shareLinksApi.list() });
  const revoke = useMutation({ mutationFn: shareLinksApi.revoke, onSuccess: refreshAll });
  const rows = links.data ?? [];
  const canRevoke = me?.role !== "viewer";

  if (links.isSuccess && rows.length === 0) {
    return (
      <EmptyState title="No share links yet">
        <p>
          Open a document and choose Share with a link. Links can expire, ask for a password and be
          revoked at any time. Every open is logged against the document.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {revoke.isError && (
        <p role="alert" className="font-medium text-destructive">
          {errorMessage(revoke.error)}
        </p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Share links in this workspace</caption>
            <thead>
              <tr className="border-b text-sm text-muted-foreground">
                {HEADINGS.map((h) => (
                  <th key={h} scope="col" className="py-2 pr-4 font-semibold">
                    {h}
                  </th>
                ))}
                <th scope="col" className="py-2 pr-4 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  canRevoke={canRevoke}
                  busy={revoke.isPending && revoke.variables === link.id}
                  onRevoke={() => {
                    revoke.mutate(link.id);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LinkRow({
  link,
  canRevoke,
  busy,
  onRevoke,
}: {
  readonly link: ShareLinkInfo;
  readonly canRevoke: boolean;
  readonly busy: boolean;
  readonly onRevoke: () => void;
}) {
  const active = shareLinkStatus(link, Date.now()) === "active";
  return (
    <tr className="border-b" data-testid="share-link-row">
      <th scope="row" className="py-3 pr-4 font-normal">
        <Link to={`/documents/${link.documentId}`} className="font-medium">
          {link.documentTitle}
        </Link>
        {(link.hasPassword || !link.allowDownload) && (
          <span className="block text-sm text-muted-foreground">
            {[link.hasPassword && "Password", !link.allowDownload && "No download"]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </th>
      <td className="py-3 pr-4">
        <ShareLinkStatusBadge link={link} />
      </td>
      <td className="tabular py-3 pr-4">{formatDateTime(link.createdAt)}</td>
      <td className="tabular py-3 pr-4">
        {link.expiresAt === null ? "Never" : formatDateTime(link.expiresAt)}
      </td>
      <td className="tabular py-3 pr-4">
        {canRevoke && link.opens > 0 ? (
          <details>
            <summary className="cursor-pointer">
              <span data-testid="share-link-opens">{link.opens}</span>
              <span className="sr-only"> opens, show each one</span>
            </summary>
            <div className="mt-2 w-64">
              <ActivityList of="shareLink" id={link.id} label="Activity on this link" />
            </div>
          </details>
        ) : (
          <span data-testid="share-link-opens">{link.opens}</span>
        )}
      </td>
      <td className="tabular py-3 pr-4">
        {link.lastOpenedAt === null ? "Not yet" : formatDateTime(link.lastOpenedAt)}
      </td>
      <td className="py-3 pr-4">
        {canRevoke && active && (
          <Button
            size="sm"
            variant="destructive"
            aria-label={`Revoke link to ${link.documentTitle} created ${formatDateTime(link.createdAt)}`}
            loading={busy}
            onClick={onRevoke}
          >
            Revoke
          </Button>
        )}
      </td>
    </tr>
  );
}
