import { AppError } from "@inkly/domain";
import { degrees, PDFDocument } from "pdf-lib";

import { assertBytesWithinCeiling, assertPagesWithinCeiling, load } from "./load.ts";
import {
  pageIndices,
  permutationIndices,
  rangeIndices,
  type PageNumber,
  type PageRange,
} from "./pages.ts";

/** A new document holding `indices` of `source`, in that order. Nothing else is carried over. */
async function extract(source: PDFDocument, indices: readonly number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const page of await out.copyPages(source, [...indices])) out.addPage(page);
  return out.save();
}

/** Concatenates `inputs` in order. Needs at least two; the total must fit the Worker ceiling. */
export async function merge(inputs: readonly Uint8Array[]): Promise<Uint8Array> {
  if (inputs.length < 2) throw new AppError("invalid_input", "merge needs at least two PDFs");
  assertBytesWithinCeiling(inputs.reduce((sum, input) => sum + input.length, 0));
  const docs: PDFDocument[] = [];
  for (const input of inputs) docs.push(await load(input));
  assertPagesWithinCeiling(docs.reduce((sum, doc) => sum + doc.getPageCount(), 0));
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const doc of docs) {
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
  }
  return out.save();
}

/** One PDF per range, in the order given. Ranges may overlap. */
export async function split(
  input: Uint8Array,
  ranges: readonly PageRange[],
): Promise<Uint8Array[]> {
  if (ranges.length === 0) throw new AppError("invalid_input", "split needs at least one range");
  const doc = await load(input);
  const count = doc.getPageCount();
  const selections = ranges.map((range) => rangeIndices(range, count));
  const parts: Uint8Array[] = [];
  for (const indices of selections) parts.push(await extract(doc, indices));
  return parts;
}

/** Turns `pages` clockwise by `deg` (a multiple of 90, may be negative) on top of their rotation. */
export async function rotate(
  input: Uint8Array,
  pages: readonly PageNumber[],
  deg: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(deg) || deg % 90 !== 0) {
    throw new AppError("invalid_input", `rotation must be a multiple of 90; got ${String(deg)}`);
  }
  const doc = await load(input);
  for (const index of pageIndices(pages, doc.getPageCount())) {
    const page = doc.getPage(index);
    page.setRotation(degrees((((page.getRotation().angle + deg) % 360) + 360) % 360));
  }
  return doc.save();
}

/** Puts the pages in `order`, which must name every page exactly once. */
export async function reorder(
  input: Uint8Array,
  order: readonly PageNumber[],
): Promise<Uint8Array> {
  const doc = await load(input);
  return extract(doc, permutationIndices(order, doc.getPageCount()));
}

/** Removes `pages`. At least one page must remain. */
export async function deletePages(
  input: Uint8Array,
  pages: readonly PageNumber[],
): Promise<Uint8Array> {
  const doc = await load(input);
  const removed = new Set(pageIndices(pages, doc.getPageCount()));
  const kept = doc.getPageIndices().filter((index) => !removed.has(index));
  if (kept.length === 0) throw new AppError("invalid_input", "cannot delete every page");
  return extract(doc, kept);
}
