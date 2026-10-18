import type { FieldKind, Point, Rect } from "@inkly/domain";

// Envelope Field geometry, like Annotations: page-relative 0..1 of the page as displayed,
// origin top-left. PDF.js draws a rotated page already turned, so the box the page occupies
// on screen is the only frame these helpers need; a page with /Rotate 90 is simply a box
// wider than it is tall.

/** Where a page sits on screen, as `getBoundingClientRect()` reports it. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A field never shrinks below this share of the page in either direction. */
export const MIN_FIELD = 0.01;

/** Default sizes in CSS pixels of an 800 px wide page, scaled with the page. */
const SIZE_PX: Record<FieldKind, { readonly w: number; readonly h: number }> = {
  signature: { w: 200, h: 48 },
  initials: { w: 80, h: 48 },
  date: { w: 140, h: 32 },
  text: { w: 200, h: 32 },
  checkbox: { w: 24, h: 24 },
};
const REFERENCE_WIDTH = 800;

/** Arrow-key steps as a share of the page: Shift takes ten at a time. */
export const STEP = 0.005;
export const BIG_STEP = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number) => Math.round(v * 1e5) / 1e5;

/** A client-pixel point as a page-relative point, clamped onto the page. */
export function toPage(clientX: number, clientY: number, box: Box): Point {
  return {
    x: clamp((clientX - box.left) / box.width, 0, 1),
    y: clamp((clientY - box.top) / box.height, 0, 1),
  };
}

/** A page-relative rect in pixels from the page's top-left corner. */
export function toPixels(rect: Rect, box: Box): Rect {
  return {
    x: rect.x * box.width,
    y: rect.y * box.height,
    w: rect.w * box.width,
    h: rect.h * box.height,
  };
}

/** Keeps a rect at least MIN_FIELD in size and wholly on the page, sliding it back on if needed. */
export function clampRect(rect: Rect): Rect {
  const w = round(clamp(rect.w, MIN_FIELD, 1));
  const h = round(clamp(rect.h, MIN_FIELD, 1));
  return { x: round(clamp(rect.x, 0, 1 - w)), y: round(clamp(rect.y, 0, 1 - h)), w, h };
}

/** A new field of `kind` centred on `at`, sized for a page drawn as `box`. */
export function fieldRectAt(kind: FieldKind, at: Point, box: Pick<Box, "width" | "height">): Rect {
  const size = SIZE_PX[kind];
  const w = size.w / REFERENCE_WIDTH;
  const h = (size.h / REFERENCE_WIDTH) * (box.width / box.height);
  return clampRect({ x: at.x - w / 2, y: at.y - h / 2, w, h });
}

/** `rect` moved by a page-relative offset, kept on the page. */
export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** `rect` with its bottom-right corner dragged to `corner`, kept on the page. */
export function resizeRect(rect: Rect, corner: Point): Rect {
  return clampRect({ ...rect, w: corner.x - rect.x, h: corner.y - rect.y });
}

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * What an arrow key does to a focused field: move it by STEP (BIG_STEP with Shift), or with
 * Alt grow or shrink it from its bottom-right corner. Null for any other key.
 */
export function nudge(
  rect: Rect,
  key: string,
  mods: { readonly shift: boolean; readonly alt: boolean },
): Rect | null {
  const dir = ARROWS[key];
  if (!dir) return null;
  const step = mods.shift ? BIG_STEP : STEP;
  const [dx, dy] = [dir[0] * step, dir[1] * step];
  return mods.alt ? clampRect({ ...rect, w: rect.w + dx, h: rect.h + dy }) : moveRect(rect, dx, dy);
}
