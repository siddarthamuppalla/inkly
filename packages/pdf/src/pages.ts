import { AppError } from "@inkly/domain";

declare const pageNumberBrand: unique symbol;

/** A 1-based page number: the first page is 1. Mint with `pageNumber`. */
export type PageNumber = number & { readonly [pageNumberBrand]: true };

/** An inclusive range of 1-based pages, `from` ≤ `to`. */
export interface PageRange {
  readonly from: PageNumber;
  readonly to: PageNumber;
}

export function pageNumber(raw: number): PageNumber {
  if (!Number.isInteger(raw) || raw < 1) {
    throw new AppError("invalid_input", `page numbers start at 1; got ${String(raw)}`);
  }
  return raw as PageNumber;
}

function assertOnPage(page: PageNumber, count: number): void {
  if (page > count) {
    throw new AppError(
      "invalid_input",
      `page ${String(page)} is past the last page (${String(count)})`,
    );
  }
}

/** Zero-based indices of `pages`, deduplicated; refuses an empty list or a page past `count`. */
export function pageIndices(pages: readonly PageNumber[], count: number): number[] {
  if (pages.length === 0) throw new AppError("invalid_input", "no pages given");
  for (const page of pages) assertOnPage(page, count);
  return [...new Set(pages)].map((page) => page - 1);
}

/** Zero-based indices of an inclusive range; refuses a reversed range or one past `count`. */
export function rangeIndices(range: PageRange, count: number): number[] {
  if (range.from > range.to) {
    throw new AppError(
      "invalid_input",
      `range ${String(range.from)}-${String(range.to)} is reversed`,
    );
  }
  assertOnPage(range.to, count);
  return Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from - 1 + i);
}

/** Zero-based indices in the order given; refuses anything but a permutation of every page. */
export function permutationIndices(order: readonly PageNumber[], count: number): number[] {
  const indices = order.length === count ? pageIndices(order, count) : [];
  if (indices.length !== count) {
    throw new AppError("invalid_input", `order must name each of the ${String(count)} pages once`);
  }
  return indices;
}
