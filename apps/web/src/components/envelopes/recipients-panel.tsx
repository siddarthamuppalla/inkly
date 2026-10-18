import type { RecipientRole } from "@inkly/domain";
import { useState } from "react";

import {
  fillVar,
  inkVar,
  moveRecipient,
  newId,
  removeRecipient,
  type Draft,
  type DraftRecipient,
} from "../../lib/envelope-draft.ts";
import { Button } from "../ui/button.tsx";
import { Field } from "../ui/field.tsx";
import { SelectField } from "../ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "../ui/sheet.tsx";

/** A swatch drawn like the Recipient's fields, so it reads the same on the page and here. */
export function InkChip({ index }: { readonly index: number }) {
  const ink = inkVar(index);
  return (
    <span
      aria-hidden="true"
      style={{
        borderColor: ink,
        backgroundColor: fillVar(index),
      }}
      className="inline-block size-4 shrink-0 rounded-sm border-2"
    />
  );
}

export function RecipientsPanel({
  draft,
  onChange,
}: {
  readonly draft: Draft;
  readonly onChange: (next: (d: Draft) => Draft) => void;
}) {
  const [added, setAdded] = useState<string | null>(null);
  const sequential = draft.orderMode === "sequential";
  const last = draft.recipients.length - 1;

  function edit(id: string, patch: Partial<DraftRecipient>) {
    onChange((d) => ({
      ...d,
      recipients: d.recipients.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }

  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle>Recipients</SheetTitle>
        <p className="text-sm text-muted-foreground">
          Signers fill in their fields; CCs get a copy when everyone has signed.
          {sequential && " Signers go in list order."}
        </p>
      </SheetHeader>
      <SheetBody className="flex flex-col gap-4">
        <ol className="flex flex-col gap-4" data-testid="recipients">
          {draft.recipients.map((r, i) => {
            const who = r.name.trim() || `recipient ${String(i + 1)}`;
            return (
              <li key={r.id} data-testid="recipient" className="border-b pb-4 last:border-b-0">
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-3 flex items-center gap-2 text-sm font-semibold">
                    <InkChip index={i} />
                    <span>
                      {sequential ? `${String(i + 1)}. ` : ""}
                      {r.role === "cc" ? "CC" : "Signer"}
                      <span className="sr-only">, recipient {i + 1}</span>
                    </span>
                  </legend>
                  <Field
                    label="Name"
                    value={r.name}
                    required
                    maxLength={200}
                    autoComplete="off"
                    autoFocus={added === r.id}
                    onChange={(e) => {
                      edit(r.id, { name: e.currentTarget.value });
                    }}
                  />
                  <Field
                    label="Email"
                    type="email"
                    value={r.email}
                    required
                    autoComplete="off"
                    onChange={(e) => {
                      edit(r.id, { email: e.currentTarget.value });
                    }}
                  />
                  <SelectField
                    label="Role"
                    value={r.role}
                    onChange={(e) => {
                      edit(r.id, { role: e.currentTarget.value as RecipientRole });
                    }}
                  >
                    <option value="signer">Signer</option>
                    <option value="cc">CC (gets a copy)</option>
                  </SelectField>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={i === 0}
                      aria-label={`Move ${who} up`}
                      onClick={() => {
                        onChange((d) => moveRecipient(d, r.id, -1));
                      }}
                    >
                      Up
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={i === last}
                      aria-label={`Move ${who} down`}
                      onClick={() => {
                        onChange((d) => moveRecipient(d, r.id, 1));
                      }}
                    >
                      Down
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${who}`}
                      onClick={() => {
                        onChange((d) => removeRecipient(d, r.id));
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </fieldset>
              </li>
            );
          })}
        </ol>
        {draft.recipients.length === 0 && (
          <p className="text-sm text-muted-foreground">No recipients yet.</p>
        )}
        <Button
          variant="secondary"
          className="self-start"
          disabled={draft.recipients.length >= 20}
          onClick={() => {
            const id = newId("rcp");
            setAdded(id);
            onChange((d) => ({
              ...d,
              recipients: [...d.recipients, { id, name: "", email: "", role: "signer" }],
            }));
          }}
        >
          Add recipient
        </Button>
      </SheetBody>
    </Sheet>
  );
}
