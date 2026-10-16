import {
  AppError,
  type FieldRect,
  type FormField,
  type FormValue,
  type FormValues,
} from "@inkly/domain";
import {
  PDFCheckBox,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFDocument,
  type PDFField,
  type PDFRef,
} from "pdf-lib";

import { load } from "./load.ts";

type Common = Pick<FormField, "name" | "page" | "rect" | "required" | "readOnly">;

const invalid = (name: string, why: string) => new AppError("invalid_input", `${name}: ${why}`);

function option(name: string, value: FormValue, options: readonly string[]): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw invalid(name, "expects one of its options or null");
  if (!options.includes(value)) throw invalid(name, `"${value}" is not one of its options`);
  return value;
}

/** How each fillable AcroForm field kind is read and written. Others (buttons, signatures) are skipped. */
const KINDS = [
  {
    is: (f: PDFField): f is PDFTextField => f instanceof PDFTextField,
    read: (f: PDFTextField, c: Common): FormField => ({
      ...c,
      type: "text",
      value: f.getText() ?? "",
      multiline: f.isMultiline(),
      maxLength: f.getMaxLength() ?? null,
    }),
    write: (f: PDFTextField, value: FormValue) => {
      if (typeof value !== "string") throw invalid(f.getName(), "expects text");
      const max = f.getMaxLength();
      if (max !== undefined && value.length > max) {
        throw invalid(f.getName(), `allows at most ${String(max)} characters`);
      }
      f.setText(value);
    },
  },
  {
    is: (f: PDFField): f is PDFCheckBox => f instanceof PDFCheckBox,
    read: (f: PDFCheckBox, c: Common): FormField => ({
      ...c,
      type: "checkbox",
      value: f.isChecked(),
    }),
    write: (f: PDFCheckBox, value: FormValue) => {
      if (typeof value !== "boolean") throw invalid(f.getName(), "expects true or false");
      if (value) f.check();
      else f.uncheck();
    },
  },
  {
    is: (f: PDFField): f is PDFRadioGroup => f instanceof PDFRadioGroup,
    read: (f: PDFRadioGroup, c: Common): FormField => ({
      ...c,
      type: "radio",
      value: f.getSelected() ?? null,
      options: f.getOptions(),
    }),
    write: (f: PDFRadioGroup, value: FormValue) => {
      const chosen = option(f.getName(), value, f.getOptions());
      if (chosen === null) f.clear();
      else f.select(chosen);
    },
  },
  {
    is: (f: PDFField): f is PDFDropdown => f instanceof PDFDropdown,
    read: (f: PDFDropdown, c: Common): FormField => ({
      ...c,
      type: "dropdown",
      value: f.getSelected()[0] ?? null,
      options: f.getOptions(),
    }),
    write: (f: PDFDropdown, value: FormValue) => {
      const chosen = option(f.getName(), value, f.getOptions());
      if (chosen === null) f.clear();
      else f.select(chosen);
    },
  },
  {
    is: (f: PDFField): f is PDFOptionList => f instanceof PDFOptionList,
    read: (f: PDFOptionList, c: Common): FormField => ({
      ...c,
      type: "optionList",
      value: f.getSelected(),
      options: f.getOptions(),
      multiple: f.isMultiselect(),
    }),
    write: (f: PDFOptionList, value: FormValue) => {
      const name = f.getName();
      if (!Array.isArray(value)) throw invalid(name, "expects a list of its options");
      const options = f.getOptions();
      for (const v of value) option(name, v, options);
      if (value.length > 1 && !f.isMultiselect()) throw invalid(name, "allows one option");
      if (value.length === 0) f.clear();
      else f.select(options.filter((o) => value.includes(o)));
    },
  },
] as const;

type Kind = (typeof KINDS)[number];

function kindOf(field: PDFField): Kind | undefined {
  return KINDS.find((k) => k.is(field));
}

/** Maps each annotation's ref to its 1-based page, so a widget can be placed. */
function pagesByAnnotation(doc: PDFDocument): Map<PDFRef, number> {
  const pages = new Map<PDFRef, number>();
  doc.getPages().forEach((page, i) => {
    for (const ref of page.node.Annots()?.asArray() ?? []) pages.set(ref as PDFRef, i + 1);
  });
  return pages;
}

function fillable(doc: PDFDocument): { field: PDFField; kind: Kind }[] {
  return doc
    .getForm()
    .getFields()
    .flatMap((field) => {
      const kind = kindOf(field);
      return kind ? [{ field, kind }] : [];
    });
}

function common(doc: PDFDocument, field: PDFField, pages: Map<PDFRef, number>): Common {
  const widget = field.acroField.getWidgets()[0];
  const { x, y, width, height }: FieldRect = widget?.getRectangle() ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  const ref = widget ? doc.context.getObjectRef(widget.dict) : undefined;
  return {
    name: field.getName(),
    page: (ref && pages.get(ref)) ?? 1,
    rect: { x, y, width, height },
    required: field.isRequired(),
    readOnly: field.isReadOnly(),
  };
}

/** Every fillable field of the PDF's AcroForm, in form order. A PDF without a form has none. */
export async function readFormFields(input: Uint8Array): Promise<FormField[]> {
  const doc = await load(input);
  const pages = pagesByAnnotation(doc);
  return fillable(doc).map(({ field, kind }) =>
    // Each KINDS entry's read takes the field type its own `is` narrowed to.
    (kind.read as (f: PDFField, c: Common) => FormField)(field, common(doc, field, pages)),
  );
}

/**
 * Sets the named fields to `values` (others keep theirs) and saves. With `flatten`, the values
 * are drawn into the page content and the form is removed. Refuses, with `invalid_input`, an
 * unknown or read-only field and a value of the wrong type or outside the field's options.
 */
export async function fillForm(
  input: Uint8Array,
  values: FormValues,
  opts: { readonly flatten: boolean },
): Promise<Uint8Array> {
  const doc = await load(input);
  const fields = new Map(fillable(doc).map((f) => [f.field.getName(), f]));
  if (fields.size === 0) throw new AppError("invalid_input", "This PDF has no form fields");
  for (const [name, value] of Object.entries(values)) {
    const entry = fields.get(name);
    if (!entry) throw invalid(name, "no such form field");
    if (entry.field.isReadOnly()) throw invalid(name, "is read-only");
    (entry.kind.write as (f: PDFField, v: FormValue) => void)(entry.field, value);
  }
  const form = doc.getForm();
  try {
    if (opts.flatten) {
      form.flatten();
      // flatten() leaves an empty AcroForm behind; viewers would still call the PDF a form.
      doc.catalog.delete(PDFName.of("AcroForm"));
    } else form.updateFieldAppearances();
  } catch (e) {
    // The standard font cannot encode some characters (e.g. CJK); that is the caller's input.
    throw new AppError(
      "invalid_input",
      `A value cannot be drawn with the form's font: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }
  return doc.save();
}
