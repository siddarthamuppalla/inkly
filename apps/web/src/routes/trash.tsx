import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { Page } from "../components/page.tsx";
import { SignedOut } from "../components/signed-out.tsx";
import { Button } from "../components/ui/button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { api, ApiError } from "../lib/api.ts";
import { formatBytes, formatDateTime, formatPages } from "../lib/format.ts";
import { keys, refreshAll, useSignedIn } from "../lib/queries.ts";

export function TrashRoute() {
  const signedIn = useSignedIn();
  return (
    <Page title="Trash" lede="Documents you deleted. Restore one to put it back where it was.">
      {signedIn === false && <SignedOut />}
      {signedIn === true && <TrashList />}
    </Page>
  );
}

function TrashList() {
  const trash = useQuery({ queryKey: keys.trash, queryFn: api.trash });
  const restore = useMutation({ mutationFn: api.restoreDocument, onSuccess: refreshAll });
  const docs = trash.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p>
        <Link to="/">Back to Documents</Link>
      </p>
      {restore.isError && (
        <p role="alert" className="font-medium text-destructive">
          {restore.error instanceof ApiError ? restore.error.message : "Restore failed."}
        </p>
      )}
      {trash.isSuccess && docs.length === 0 && (
        <EmptyState title="Trash is empty">
          <p>Documents you move to Trash appear here until you restore them.</p>
        </EmptyState>
      )}
      {docs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Documents in Trash</caption>
            <thead>
              <tr className="border-b text-sm text-muted-foreground">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Size
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Deleted
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b" data-testid="trash-row">
                  <th scope="row" className="py-3 pr-4 font-normal">
                    <Link to={`/documents/${d.id}`} className="font-medium">
                      {d.title}
                    </Link>
                  </th>
                  <td className="tabular py-3 pr-4">
                    {formatPages(d.pages)} · {formatBytes(d.bytes)}
                  </td>
                  <td className="tabular py-3 pr-4">
                    {formatDateTime(d.deletedAt ?? d.updatedAt)}
                  </td>
                  <td className="py-3 pr-4">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Restore ${d.title}`}
                      loading={restore.isPending && restore.variables === d.id}
                      onClick={() => {
                        restore.mutate(d.id);
                      }}
                    >
                      Restore
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
