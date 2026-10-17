import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type AppErrorCode, type FormValues } from "@inkly/domain";
import { verifyFile } from "@inkly/testing";
import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it } from "vitest";

import { fillForm, readFormFields } from "../src/index.ts";

const corpus = join(import.meta.dirname, "../../../fixtures/pdfs");
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(corpus, name)));
const out = mkdtempSync(join(tmpdir(), "inkly-forms-test-"));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

let written = 0;
function save(bytes: Uint8Array): string {
  const file = join(out, `out-${String(++written)}.pdf`);
  writeFileSync(file, bytes);
  return file;
}

/** Runs verify-pdf on `bytes` and returns whether pdfinfo still reports a form. */
function verified(bytes: Uint8Array, expectPages: number): boolean {
  const r = verifyFile(save(bytes), { expectPages });
  expect(r.failures).toEqual([]);
  expect(r.ok).toBe(true);
  return r.info?.form ?? false;
}

const pageText = (bytes: Uint8Array): string =>
  execFileSync("pdftotext", [save(bytes), "-"], { encoding: "utf8" });

async function rejection(promise: Promise<unknown>): Promise<AppErrorCode> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  throw new Error("expected the operation to fail");
}

/** Two pages; page 2 holds a radio group, a dropdown, an option list and a read-only field. */
async function everyKind(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.setMaxLength(40);
  notes.addToPage(page, { x: 10, y: 300, width: 200, height: 60 });
  const size = form.createRadioGroup("size");
  size.addOptionToPage("S", page, { x: 10, y: 250, width: 15, height: 15 });
  size.addOptionToPage("M", page, { x: 40, y: 250, width: 15, height: 15 });
  const country = form.createDropdown("country");
  country.addOptions(["France", "Japan"]);
  country.addToPage(page, { x: 10, y: 200, width: 120, height: 20 });
  const toppings = form.createOptionList("toppings");
  toppings.addOptions(["Basil", "Olive", "Tomato"]);
  toppings.enableMultiselect();
  toppings.addToPage(page, { x: 10, y: 100, width: 120, height: 60 });
  const locked = form.createTextField("locked");
  locked.setText("fixed");
  locked.enableReadOnly();
  locked.addToPage(page, { x: 200, y: 100, width: 100, height: 20 });
  form.createButton("submit").addToPage("Submit", page, { x: 300, y: 10, width: 60, height: 20 });
  return doc.save();
}

describe("readFormFields", () => {
  it("lists forms.pdf's fields with type, value, page and rect", async () => {
    expect(await readFormFields(fixture("forms.pdf"))).toEqual([
      {
        name: "full_name",
        type: "text",
        value: "",
        multiline: false,
        maxLength: 100,
        page: 1,
        rect: { x: 180, y: 640, width: 300, height: 22 },
        required: false,
        readOnly: false,
      },
      {
        name: "email",
        type: "text",
        value: "",
        multiline: false,
        maxLength: 100,
        page: 1,
        rect: { x: 180, y: 590, width: 300, height: 22 },
        required: false,
        readOnly: false,
      },
      {
        name: "agree",
        type: "checkbox",
        value: false,
        page: 1,
        rect: { x: 180, y: 545, width: 18, height: 18 },
        required: true,
        readOnly: false,
      },
    ]);
  });

  it("reads radio, dropdown and option-list options and skips push buttons", async () => {
    const fields = await readFormFields(await everyKind());
    expect(fields.map((f) => [f.name, f.type, f.page])).toEqual([
      ["notes", "text", 2],
      ["size", "radio", 2],
      ["country", "dropdown", 2],
      ["toppings", "optionList", 2],
      ["locked", "text", 2],
    ]);
    expect(fields[0]).toMatchObject({ multiline: true, maxLength: 40 });
    expect(fields[1]).toMatchObject({ value: null, options: ["S", "M"] });
    expect(fields[2]).toMatchObject({ value: null, options: ["France", "Japan"] });
    expect(fields[3]).toMatchObject({ value: [], options: ["Basil", "Olive", "Tomato"] });
    expect(fields[3]).toMatchObject({ multiple: true });
    expect(fields[4]).toMatchObject({ value: "fixed", readOnly: true });
  });

  it("returns no fields for a PDF without a form", async () => {
    expect(await readFormFields(fixture("10p.pdf"))).toEqual([]);
  });

  it("refuses malformed and encrypted input", async () => {
    expect(await rejection(readFormFields(fixture("malformed.pdf")))).toBe("pdf_malformed");
    expect(await rejection(readFormFields(fixture("encrypted.pdf")))).toBe("pdf_encrypted");
  });
});

describe("fillForm", () => {
  const values: FormValues = { full_name: "Ada Lovelace", email: "ada@example.test", agree: true };

  it("fills forms.pdf; the saved bytes pass verify-pdf and read back the values", async () => {
    const bytes = await fillForm(fixture("forms.pdf"), values, { flatten: false });
    expect(verified(bytes, 1)).toBe(true);
    const read = Object.fromEntries((await readFormFields(bytes)).map((f) => [f.name, f.value]));
    expect(read).toEqual(values);
  });

  it("leaves fields it is not given unchanged", async () => {
    const once = await fillForm(fixture("forms.pdf"), values, { flatten: false });
    const twice = await fillForm(once, { email: "new@example.test" }, { flatten: false });
    const read = Object.fromEntries((await readFormFields(twice)).map((f) => [f.name, f.value]));
    expect(read).toEqual({ ...values, email: "new@example.test" });
  });

  it("flattens: no form fields remain and the values are drawn on the page", async () => {
    const bytes = await fillForm(fixture("forms.pdf"), values, { flatten: true });
    expect(verified(bytes, 1)).toBe(false);
    expect(await readFormFields(bytes)).toEqual([]);
    const text = pageText(bytes);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("ada@example.test");
  });

  it("sets and clears radio, dropdown and option-list values", async () => {
    const filled = await fillForm(
      await everyKind(),
      { notes: "line one\nline two", size: "M", country: "Japan", toppings: ["Olive", "Basil"] },
      { flatten: false },
    );
    expect(verified(filled, 2)).toBe(true);
    const read = Object.fromEntries((await readFormFields(filled)).map((f) => [f.name, f.value]));
    expect(read).toMatchObject({
      notes: "line one\nline two",
      size: "M",
      country: "Japan",
      toppings: ["Basil", "Olive"],
    });

    const cleared = await fillForm(
      filled,
      { size: null, country: null, toppings: [] },
      { flatten: false },
    );
    const after = Object.fromEntries((await readFormFields(cleared)).map((f) => [f.name, f.value]));
    expect(after).toMatchObject({ size: null, country: null, toppings: [] });
  });

  it("refuses an unknown field, a value outside the options and a mistyped value", async () => {
    const form = fixture("forms.pdf");
    const kinds = await everyKind();
    const refused: [Uint8Array, FormValues][] = [
      [form, { nickname: "x" }],
      [kinds, { submit: "x" }],
      [form, { full_name: true }],
      [form, { agree: "yes" }],
      [kinds, { size: "XL" }],
      [kinds, { size: true }],
      [kinds, { country: "Spain" }],
      [kinds, { country: ["Japan"] }],
      [kinds, { toppings: ["Basil", "Ham"] }],
      [kinds, { toppings: "Basil" }],
      [kinds, { notes: "x".repeat(41) }],
      [kinds, { locked: "changed" }],
      [form, { full_name: "日本語" }],
    ];
    for (const [bytes, bad] of refused) {
      expect(await rejection(fillForm(bytes, bad, { flatten: false })), JSON.stringify(bad)).toBe(
        "invalid_input",
      );
    }
  });

  it("refuses a single-choice option list given two options", async () => {
    const doc = await PDFDocument.create();
    const list = doc.getForm().createOptionList("one");
    list.addOptions(["A", "B"]);
    list.addToPage(doc.addPage(), { x: 10, y: 10, width: 50, height: 40 });
    const bytes = await doc.save();
    expect(await rejection(fillForm(bytes, { one: ["A", "B"] }, { flatten: false }))).toBe(
      "invalid_input",
    );
  });

  it("refuses a PDF without a form", async () => {
    expect(await rejection(fillForm(fixture("tiny.pdf"), {}, { flatten: false }))).toBe(
      "invalid_input",
    );
  });
});
