import { fieldFilled, type SignerField } from "@inkly/domain";

// Pure helpers for the /sign page (T3.3): field order, completeness and labels.

/** The signer's Fields in reading order: page, then top to bottom, then left to right. */
export function inPageOrder(fields: readonly SignerField[]): SignerField[] {
  return [...fields].sort((a, b) => a.page - b.page || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

export type FieldValues = Readonly<Record<string, string>>;

/** The required Fields still missing a value. */
export function missingFields(fields: readonly SignerField[], values: FieldValues): SignerField[] {
  return fields.filter((f) => f.required && !fieldFilled(f.kind, values[f.id]));
}

/** The Field "Next field" goes to: the first unfilled one after `current`, wrapping round. */
export function nextField(
  ordered: readonly SignerField[],
  values: FieldValues,
  current: string | null,
): SignerField | null {
  const start = current === null ? -1 : ordered.findIndex((f) => f.id === current);
  for (let step = 1; step <= ordered.length; step++) {
    const field = ordered[(start + step) % ordered.length];
    if (field && !fieldFilled(field.kind, values[field.id])) return field;
  }
  return null;
}

const KIND_LABEL: Record<SignerField["kind"], string> = {
  signature: "Signature",
  initials: "Initials",
  date: "Date",
  text: "Text",
  checkbox: "Checkbox",
};

/** "Signature 1 of 2, page 1 (required)": how a Field is named to assistive tech. */
export function fieldName(field: SignerField, ordered: readonly SignerField[]): string {
  const same = ordered.filter((f) => f.kind === field.kind);
  const n = same.indexOf(field) + 1;
  const count = same.length > 1 ? ` ${String(n)} of ${String(same.length)}` : "";
  return `${KIND_LABEL[field.kind]}${count}, page ${String(field.page)}${field.required ? " (required)" : ""}`;
}

/** The initials of a name: "Ana María Ruiz" → "AMR". */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 4);
}

/** Only the values the server takes: no dates (it fills those) and no blanks. */
export function submittedValues(fields: readonly SignerField[], values: FieldValues) {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const value = values[f.id];
      return f.kind === "date" || value === undefined || value === "" ? [] : [[f.id, value]];
    }),
  ) as Record<string, string>;
}
