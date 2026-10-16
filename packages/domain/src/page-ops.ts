import { z } from "zod";

// Request shapes for the page ops (rotate, reorder, delete pages, merge, split),
// shared by workers/api and apps/web. Pages are 1-based.

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Page = z.number().int().min(1);
const Pages = z.array(Page).min(1).max(1000);

export const RotateRequest = z.object({
  pages: Pages,
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)]),
});
export type RotateRequest = z.infer<typeof RotateRequest>;

export const ReorderRequest = z.object({ order: Pages });
export type ReorderRequest = z.infer<typeof ReorderRequest>;

export const DeletePagesRequest = z.object({ pages: Pages });
export type DeletePagesRequest = z.infer<typeof DeletePagesRequest>;

export const MergeRequest = z.object({
  documentIds: z.array(Id).min(2, "merge needs at least two Documents").max(20),
  title: z.string().trim().min(1).max(200).optional(),
});
export type MergeRequest = z.infer<typeof MergeRequest>;

export const SplitRange = z
  .object({ from: Page, to: Page })
  .refine((r) => r.from <= r.to, "a range must not be reversed");
export const SplitRequest = z.object({ ranges: z.array(SplitRange).min(1).max(50) });
export type SplitRequest = z.infer<typeof SplitRequest>;

/** Parses "1-3, 5, 8-9" into ranges; null when any part is not a page or an ordered range. */
export function parseRanges(text: string): { from: number; to: number }[] | null {
  const parts = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length === 0) return null;
  const ranges: { from: number; to: number }[] = [];
  for (const part of parts) {
    const match = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to < from) return null;
    ranges.push({ from, to });
  }
  return ranges;
}
