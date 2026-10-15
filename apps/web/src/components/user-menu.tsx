import { useState } from "react";

import { errorMessage, type Me } from "../lib/api.ts";
import { signOut, switchTenant } from "../lib/session.ts";
import { Button } from "./ui/button.tsx";
import { SelectField } from "./ui/select-field.tsx";

/** The signed-in User, their Active tenant (switchable) and sign-out. */
export function UserMenu({ me }: { readonly me: Me }) {
  const [error, setError] = useState<string>();

  function act(action: () => Promise<void>) {
    setError(undefined);
    action().catch((err: unknown) => {
      setError(errorMessage(err));
    });
  }

  return (
    <section
      data-testid="user-menu"
      aria-label="Account"
      className="flex flex-col gap-3 rounded-md border bg-card p-3 text-sm"
    >
      <SelectField
        label="Workspace"
        value={me.activeTenant?.id ?? ""}
        onChange={(e) => {
          const id = e.currentTarget.value;
          act(() => switchTenant(id));
        }}
      >
        {me.tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </SelectField>
      <p className="flex flex-col">
        <span className="font-semibold">{me.user.name}</span>
        <span className="break-all text-muted-foreground">{me.user.email}</span>
      </p>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          act(signOut);
        }}
      >
        Sign out
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
