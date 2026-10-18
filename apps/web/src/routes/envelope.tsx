import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";

import { DraftEditor } from "../components/envelopes/draft-editor.tsx";
import { StatusView } from "../components/envelopes/status-view.tsx";
import { Page } from "../components/page.tsx";
import { envelopeKeys, envelopesApi } from "../lib/envelopes-api.ts";
import { useMe } from "../lib/session.ts";

/** `/envelopes/:id`: the draft editor until it is sent, the status page after. */
export function EnvelopeRoute() {
  const { id = "" } = useParams();
  const me = useMe();
  const envelope = useQuery({
    queryKey: envelopeKeys.envelope(id),
    queryFn: () => envelopesApi.get(id),
  });

  if (envelope.isError) {
    return (
      <Page title="Envelope not found">
        <p className="max-w-prose text-muted-foreground">
          This envelope does not exist in your workspace, or it was a draft that has been deleted.{" "}
          <Link to="/envelopes">Back to Envelopes</Link>
        </p>
      </Page>
    );
  }
  if (!envelope.data) return <Page title="Envelope">{null}</Page>;
  const detail = envelope.data;
  // Viewers can read a draft but not change it, so they get the read-only page.
  return detail.envelope.status === "draft" && me?.role !== "viewer" ? (
    <DraftEditor key={detail.envelope.id} detail={detail} />
  ) : (
    <StatusView detail={detail} />
  );
}
