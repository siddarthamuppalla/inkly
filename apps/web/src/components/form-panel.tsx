import type { DocumentInfo, FormField, FormValue, FormValues } from "@inkly/domain";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";

import { ApiError } from "../lib/api.ts";
import { fieldLabel, formsApi } from "../lib/forms-api.ts";
import { refreshAll } from "../lib/queries.ts";
import { useMe } from "../lib/session.ts";
import { Button } from "./ui/button.tsx";
import { Field } from "./ui/field.tsx";
import { SelectField } from "./ui/select-field.tsx";
import { Sheet, SheetBody, SheetHeader, SheetTitle } from "./ui/sheet.tsx";

/** "Fill form" for a Document whose current Version has form fields; nothing otherwise. */
export function FormPanel({ doc }: { readonly doc: DocumentInfo }) {
  const fields = useQuery({
    queryKey: ["form", doc.id, doc.currentVersion],
    queryFn: () => formsApi.fields(doc.id),
    staleTime: Infinity,
  });
  const [saved, setSaved] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: ({ values, flatten }: { values: FormValues; flatten: boolean }) =>
      formsApi.fill(doc.id, values, flatten),
    onSuccess: async (document) => {
      setSaved(document.currentVersion);
      await refreshAll();
    },
  });
  const viewer = useMe()?.role === "viewer";

  if (!fields.data || fields.data.length === 0) return null;
  return (
    <Sheet>
      <SheetHeader>
        <SheetTitle className="text-xl">Fill form</SheetTitle>
        <p className="text-sm text-muted-foreground">
          {viewer
            ? "Viewers can read this form but not fill it."
            : "Saving adds a new version; earlier versions keep their values."}
        </p>
      </SheetHeader>
      <SheetBody>
        <FormFields
          key={doc.currentVersion}
          fields={fields.data}
          disabled={viewer}
          busy={save.isPending}
          onSave={(values, flatten) => {
            setSaved(null);
            save.mutate({ values, flatten });
          }}
        />
        {saved !== null && !save.isPending && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            Saved as version {saved}.
          </p>
        )}
        {save.isError && (
          <p role="alert" className="mt-3 text-sm font-medium text-destructive">
            {save.error instanceof ApiError
              ? save.error.message
              : "Something went wrong. Try again."}
          </p>
        )}
      </SheetBody>
    </Sheet>
  );
}

function FormFields({
  fields,
  disabled,
  busy,
  onSave,
}: {
  readonly fields: readonly FormField[];
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly onSave: (values: FormValues, flatten: boolean) => void;
}) {
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    Object.fromEntries(fields.filter((f) => !f.readOnly).map((f) => [f.name, f.value])),
  );
  const [flatten, setFlatten] = useState(false);
  const set = (name: string) => (value: FormValue) => {
    setValues((v) => ({ ...v, [name]: value }));
  };

  return (
    <form
      className="flex flex-col gap-4"
      aria-label="Form fields"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(values, flatten);
      }}
    >
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name] ?? field.value}
          disabled={disabled || field.readOnly}
          onChange={set(field.name)}
        />
      ))}
      <Check
        label="Flatten"
        hint="Draws the values into the page and removes the fields, so they can no longer be edited."
        checked={flatten}
        disabled={disabled}
        onChange={setFlatten}
      />
      <Button type="submit" className="self-start" loading={busy} disabled={disabled}>
        Save
      </Button>
    </form>
  );
}

const requiredHint = (field: FormField) => (field.required ? "Required by this form" : undefined);

function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  readonly field: FormField;
  readonly value: FormValue;
  readonly disabled: boolean;
  readonly onChange: (value: FormValue) => void;
}) {
  const hint = requiredHint(field);
  const label = fieldLabel(field.name);
  switch (field.type) {
    case "text":
      return field.multiline ? (
        <TextArea
          label={label}
          hint={hint}
          value={typeof value === "string" ? value : ""}
          maxLength={field.maxLength ?? undefined}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <Field
          label={label}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          {...(hint ? { hint } : {})}
          {...(field.maxLength === null ? {} : { maxLength: field.maxLength })}
          onChange={(e) => {
            onChange(e.currentTarget.value);
          }}
        />
      );
    case "checkbox":
      return (
        <Check
          label={label}
          hint={hint}
          checked={value === true}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case "radio":
      return (
        <Choices legend={label} hint={hint}>
          {field.options.map((option) => (
            <Choice
              key={option}
              type="radio"
              name={field.name}
              label={option}
              checked={value === option}
              disabled={disabled}
              onChange={() => {
                onChange(option);
              }}
            />
          ))}
        </Choices>
      );
    case "dropdown":
      return (
        <SelectField
          label={label}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.currentTarget.value === "" ? null : e.currentTarget.value);
          }}
        >
          <option value="">No selection</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>
      );
    case "optionList": {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <Choices legend={label} hint={hint}>
          {field.options.map((option) => (
            <Choice
              key={option}
              type={field.multiple ? "checkbox" : "radio"}
              name={field.name}
              label={option}
              checked={chosen.includes(option)}
              disabled={disabled}
              onChange={(checked) => {
                const others = field.multiple ? chosen.filter((c) => c !== option) : [];
                onChange(checked ? [...others, option] : others);
              }}
            />
          ))}
        </Choices>
      );
    }
  }
}

function Check({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly hint: string | undefined;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className="mt-1 size-5 accent-primary"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => {
          onChange(e.currentTarget.checked);
        }}
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-semibold">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className="text-sm text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function Choices({
  legend,
  hint,
  children,
}: {
  readonly legend: string;
  readonly hint: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-semibold">{legend}</legend>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

function Choice({
  type,
  name,
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly type: "radio" | "checkbox";
  readonly name: string;
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-base">
      <input
        type={type}
        name={name}
        className="size-5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.currentTarget.checked);
        }}
      />
      {label}
    </label>
  );
}

function TextArea({
  label,
  hint,
  value,
  maxLength,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly hint: string | undefined;
  readonly value: string;
  readonly maxLength: number | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="rounded-md border border-input bg-card px-3 py-2 text-base text-card-foreground"
        onChange={(e) => {
          onChange(e.currentTarget.value);
        }}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
