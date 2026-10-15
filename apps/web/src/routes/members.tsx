import { useCallback, useEffect, useState, type SubmitEvent } from "react";

import { Page } from "../components/page.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Field } from "../components/ui/field.tsx";
import { SelectField } from "../components/ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { api, errorMessage } from "../lib/api.ts";
import { formText } from "../lib/form.ts";
import { useMe } from "../lib/session.ts";

interface Member {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: string;
}

interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
}

interface Roster {
  readonly members: readonly Member[];
  readonly invitations: readonly Invitation[];
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

export function MembersRoute() {
  const me = useMe();
  const [roster, setRoster] = useState<Roster>();
  const [loadError, setLoadError] = useState<string>();
  const [inviteError, setInviteError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const canManage = me?.role === "owner" || me?.role === "admin";
  const myId = me?.user.id;

  const load = useCallback(async () => {
    try {
      setRoster(await api<Roster>("/api/tenant/members"));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function invite(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = formText(data, "email");
    setBusy(true);
    setInviteError(undefined);
    setNotice(undefined);
    api("/api/tenant/invitations", { method: "POST", json: { email, role: data.get("role") } })
      .then(async () => {
        form.reset();
        setNotice(`Invitation sent to ${email}.`);
        await load();
      })
      .catch((err: unknown) => {
        setInviteError(errorMessage(err));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function remove(member: Member) {
    setNotice(undefined);
    api(`/api/tenant/members/${member.userId}`, { method: "DELETE" })
      .then(async () => {
        setNotice(`${member.email} was removed.`);
        await load();
      })
      .catch((err: unknown) => {
        setNotice(errorMessage(err));
      });
  }

  return (
    <Page
      title="Members"
      lede={`People who can open ${me?.activeTenant?.name ?? "this workspace"}.`}
    >
      <div className="flex max-w-3xl flex-col gap-8">
        <p role="status" className="min-h-6 text-sm">
          {notice}
        </p>
        {loadError && <p className="text-destructive">{loadError}</p>}
        <section aria-labelledby="members-heading" className="flex flex-col gap-3">
          <h2 id="members-heading" className="text-2xl">
            In this workspace
          </h2>
          <ul
            data-testid="member-list"
            className="flex flex-col divide-y rounded-md border bg-card"
          >
            {roster?.members.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span className="flex min-w-0 flex-col">
                  <span className="font-semibold">{m.name}</span>
                  <span className="break-all text-sm text-muted-foreground">{m.email}</span>
                </span>
                <span className="flex items-center gap-3">
                  <Badge>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                  {canManage && m.role !== "owner" && m.userId !== myId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        remove(m);
                      }}
                    >
                      Remove<span className="sr-only"> {m.email}</span>
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
        {roster && roster.invitations.length > 0 && (
          <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
            <h2 id="pending-heading" className="text-2xl">
              Waiting to join
            </h2>
            <ul
              data-testid="invitation-list"
              className="flex flex-col divide-y rounded-md border bg-card"
            >
              {roster.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <span className="break-all">{i.email}</span>
                  <Badge variant="warning">Invited as {ROLE_LABEL[i.role] ?? i.role}</Badge>
                </li>
              ))}
            </ul>
          </section>
        )}
        {canManage && (
          <Sheet>
            <SheetHeader>
              <SheetTitle>Invite someone</SheetTitle>
              <p className="text-sm text-muted-foreground">
                They get an email with a link to join. The Free plan has room for 1 member; Pro has
                room for 5.
              </p>
            </SheetHeader>
            <SheetBody>
              <form className="grid gap-5 sm:grid-cols-[1fr_10rem]" onSubmit={invite} noValidate>
                <Field
                  label="Email"
                  name="email"
                  type="email"
                  autoComplete="off"
                  required
                  {...(inviteError !== undefined && { error: inviteError })}
                />
                <SelectField label="Role" name="role" defaultValue="editor">
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                  <option value="admin">Admin</option>
                </SelectField>
                <Button
                  type="submit"
                  loading={busy}
                  className="sm:col-span-2 sm:justify-self-start"
                >
                  Send invitation
                </Button>
              </form>
            </SheetBody>
          </Sheet>
        )}
      </div>
    </Page>
  );
}
