import { z } from "zod";

// Form fields of a Version (AcroForm), shared by packages/pdf, workers/api and apps/web.

/** A widget's box on its page, in points from the bottom-left corner. */
export const FieldRect = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type FieldRect = z.infer<typeof FieldRect>;

const Base = {
  name: z.string(),
  /** 1-based page of the field's first widget. */
  page: z.number().int().min(1),
  rect: FieldRect,
  required: z.boolean(),
  readOnly: z.boolean(),
};
const Options = z.array(z.string());

export const FormField = z.discriminatedUnion("type", [
  z.object({
    ...Base,
    type: z.literal("text"),
    value: z.string(),
    multiline: z.boolean(),
    maxLength: z.number().int().nullable(),
  }),
  z.object({ ...Base, type: z.literal("checkbox"), value: z.boolean() }),
  z.object({ ...Base, type: z.literal("radio"), value: z.string().nullable(), options: Options }),
  z.object({
    ...Base,
    type: z.literal("dropdown"),
    value: z.string().nullable(),
    options: Options,
  }),
  z.object({
    ...Base,
    type: z.literal("optionList"),
    value: Options,
    options: Options,
    multiple: z.boolean(),
  }),
]);
export type FormField = z.infer<typeof FormField>;
export type FormFieldType = FormField["type"];

/** text: string · checkbox: boolean · radio/dropdown: an option or null · optionList: options. */
export const FormValue = z.union([z.string(), z.boolean(), z.array(z.string()), z.null()]);
export type FormValue = z.infer<typeof FormValue>;
export type FormValues = Readonly<Record<string, FormValue>>;

export const FormFill = z.object({
  values: z.record(z.string(), FormValue),
  flatten: z.boolean().default(false),
});
export type FormFill = z.infer<typeof FormFill>;

export const FormFieldsResponse = z.object({ fields: z.array(FormField) });
