// A Document's form fields (T2.1). Saving a filled form adds a new Version.
import {
  DocumentResponse,
  FormFieldsResponse,
  type DocumentInfo,
  type FormField,
  type FormValues,
} from "@inkly/domain";

import { call, jsonInit } from "./documents-api.ts";

export const formsApi = {
  fields: async (id: string): Promise<FormField[]> =>
    (await call(FormFieldsResponse, `/api/documents/${id}/form`)).fields,
  fill: async (id: string, values: FormValues, flatten: boolean): Promise<DocumentInfo> =>
    (
      await call(
        DocumentResponse,
        `/api/documents/${id}/form`,
        jsonInit("POST", { values, flatten }),
      )
    ).document,
};

/** A field name as a label: "full_name" reads "Full name". */
export function fieldLabel(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
