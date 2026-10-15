import { useState } from "react";
import { useParams } from "react-router";

import { Page } from "../components/page.tsx";
import { Button } from "../components/ui/button.tsx";
import { api, errorMessage } from "../lib/api.ts";

export function InvitationRoute() {
  const { id = "" } = useParams();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  function accept() {
    setBusy(true);
    setError(undefined);
    api(`/api/invitations/${encodeURIComponent(id)}/accept`, { method: "POST" })
      .then(() => {
        window.location.assign("/");
      })
      .catch((err: unknown) => {
        setError(errorMessage(err));
        setBusy(false);
      });
  }

  return (
    <Page
      title="Join a workspace"
      lede="You were invited to a workspace on Inkly. Accepting adds it to your workspace menu and opens it."
    >
      <div className="flex flex-col items-start gap-4">
        <Button onClick={accept} loading={busy}>
          Accept invitation
        </Button>
        <p role="alert" className="text-destructive">
          {error}
        </p>
      </div>
    </Page>
  );
}
