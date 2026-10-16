import type { FolderInfo } from "@inkly/domain";
import { describe, expect, it } from "vitest";

import { folderChoices, folderPath } from "../src/lib/folders.ts";

const f = (id: string, name: string, parentId: string | null): FolderInfo => ({
  id,
  name,
  parentId,
  createdAt: 0,
});
const folders = [f("c", "Contracts", null), f("y", "2026", "c"), f("i", "Invoices", null)];

describe("folderPath", () => {
  it("walks up to the top level", () => {
    expect(folderPath(folders, "y").map((p) => p.name)).toEqual(["Contracts", "2026"]);
    expect(folderPath(folders, null)).toEqual([]);
    expect(folderPath(folders, "missing")).toEqual([]);
  });

  it("stops on a cycle instead of looping", () => {
    const loop = [f("a", "A", "b"), f("b", "B", "a")];
    expect(folderPath(loop, "a").map((p) => p.name)).toEqual(["B", "A"]);
  });
});

describe("folderChoices", () => {
  it("labels each folder with its full path, sorted", () => {
    expect(folderChoices(folders)).toEqual([
      { id: "c", label: "Contracts" },
      { id: "y", label: "Contracts / 2026" },
      { id: "i", label: "Invoices" },
    ]);
  });
});
