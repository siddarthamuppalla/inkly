import type { Point } from "@inkly/domain";
import type { PDFPage } from "pdf-lib";

const ROTATIONS = [0, 90, 180, 270] as const;
export type Rotation = (typeof ROTATIONS)[number];

export function rotationOf(page: PDFPage): Rotation {
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  return ROTATIONS.find((r) => r === angle) ?? 0;
}

/** Maps a page-relative point on the displayed (rotated) page to PDF user space. */
export function toUserSpace(page: PDFPage, p: Point): [number, number] {
  const box = page.getCropBox();
  const [s, t] = (
    {
      0: [p.x, p.y],
      90: [p.y, 1 - p.x],
      180: [1 - p.x, 1 - p.y],
      270: [1 - p.y, p.x],
    } as const satisfies Record<Rotation, readonly [number, number]>
  )[rotationOf(page)];
  return [box.x + s * box.width, box.y + (1 - t) * box.height];
}

/** The displayed page's width and height in points, after rotation. */
export function displaySize(page: PDFPage): { width: number; height: number } {
  const box = page.getCropBox();
  return rotationOf(page) % 180 === 0
    ? { width: box.width, height: box.height }
    : { width: box.height, height: box.width };
}
