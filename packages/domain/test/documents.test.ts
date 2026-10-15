import { describe, expect, it } from "vitest";

import { DocumentPatch, FolderCreate, FolderPatch, titleFromFilename } from "../src/index.ts";

describe("document request schemas", () => {
  it("accepts a rename, a move, or both, and trims the title", () => {
    expect(DocumentPatch.parse({ title: "  Lease  " })).toEqual({ title: "Lease" });
    expect(DocumentPatch.parse({ folderId: null })).toEqual({ folderId: null });
    expect(DocumentPatch.parse({ title: "a", folderId: "fld_1" })).toEqual({
      title: "a",
      folderId: "fld_1",
    });
  });

  it.each([{}, { title: "" }, { title: "x".repeat(201) }, { folderId: "../t_b" }])(
    "rejects %j",
    (body) => {
      expect(DocumentPatch.safeParse(body).success).toBe(false);
    },
  );

  it("defaults a new folder to the root and refuses an empty name", () => {
    expect(FolderCreate.parse({ name: "Contracts" })).toEqual({
      name: "Contracts",
      parentId: null,
    });
    expect(FolderCreate.safeParse({ name: " " }).success).toBe(false);
    expect(FolderPatch.safeParse({}).success).toBe(false);
  });
});

describe("titleFromFilename", () => {
  it.each([
    ["10p.pdf", "10p"],
    ["Lease Agreement.PDF", "Lease Agreement"],
    ["  ", "Untitled"],
    [undefined, "Untitled"],
    ["no-extension", "no-extension"],
  ])("%j → %j", (name, title) => {
    expect(titleFromFilename(name)).toBe(title);
  });
});
