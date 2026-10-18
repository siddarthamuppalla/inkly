import { Rect } from "@inkly/domain";
import { describe, expect, it } from "vitest";

import {
  BIG_STEP,
  clampRect,
  fieldRectAt,
  MIN_FIELD,
  moveRect,
  nudge,
  resizeRect,
  STEP,
  toPage,
  toPixels,
} from "../src/lib/field-geometry.ts";

const portrait = { left: 100, top: 50, width: 800, height: 1035 };
// The same Letter page with /Rotate 90, as PDF.js draws it: turned, so wider than tall.
const rotated = { left: 100, top: 50, width: 800, height: 618 };

const near = (a: Rect, b: Rect) => {
  for (const k of ["x", "y", "w", "h"] as const) expect(a[k]).toBeCloseTo(b[k], 4);
};

describe("toPage and toPixels", () => {
  it("map client pixels to 0..1 of the page as displayed, origin top-left", () => {
    expect(toPage(100, 50, portrait)).toEqual({ x: 0, y: 0 });
    expect(toPage(500, 567.5, portrait)).toEqual({ x: 0.5, y: 0.5 });
    expect(toPage(900, 668, rotated)).toEqual({ x: 1, y: 1 });
  });

  it("clamp a point outside the page onto its edge", () => {
    expect(toPage(0, 2000, portrait)).toEqual({ x: 0, y: 1 });
  });

  it("round-trip a rect through the rotated page's box", () => {
    const rect = { x: 0.25, y: 0.5, w: 0.25, h: 0.1 };
    const px = toPixels(rect, rotated);
    near(px, { x: 200, y: 309, w: 200, h: 61.8 });
    const back = toPage(rotated.left + px.x, rotated.top + px.y, rotated);
    expect(back.x).toBeCloseTo(rect.x, 9);
    expect(back.y).toBeCloseTo(rect.y, 9);
  });
});

describe("clampRect", () => {
  it("slides a rect hanging off the page back on without resizing it", () => {
    expect(clampRect({ x: 0.9, y: -0.2, w: 0.3, h: 0.1 })).toEqual({
      x: 0.7,
      y: 0,
      w: 0.3,
      h: 0.1,
    });
  });

  it("keeps a rect at least MIN_FIELD and at most the page", () => {
    expect(clampRect({ x: 0.5, y: 0.5, w: 0, h: 3 })).toEqual({ x: 0.5, y: 0, w: MIN_FIELD, h: 1 });
  });

  it("always yields a rect the API accepts", () => {
    for (const r of [
      { x: 0.99999, y: 0.99999, w: 0.33333, h: 0.07777 },
      { x: -1, y: 2, w: 0.123456789, h: 0.987654321 },
    ]) {
      expect(Rect.safeParse(clampRect(r)).success).toBe(true);
    }
  });
});

describe("fieldRectAt", () => {
  it("centres a default-sized field on the point", () => {
    near(fieldRectAt("signature", { x: 0.5, y: 0.5 }, portrait), {
      x: 0.375,
      y: 0.5 - 48 / 1035 / 2,
      w: 0.25,
      h: 48 / 1035,
    });
  });

  it("keeps a field the same on-screen size on a rotated page", () => {
    const box = toPixels(fieldRectAt("signature", { x: 0.5, y: 0.5 }, rotated), rotated);
    // Within the 1e-5 rounding of stored geometry.
    expect(box.w).toBeCloseTo(200, 2);
    expect(box.h).toBeCloseTo(48, 2);
  });

  it("keeps a field placed at the corner wholly on the page", () => {
    expect(fieldRectAt("text", { x: 1, y: 1 }, portrait)).toMatchObject({
      x: 0.75,
      y: 1 - 0.03092,
    });
  });
});

describe("moveRect and resizeRect", () => {
  const rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };

  it("move by an offset and stop at the page edge", () => {
    near(moveRect(rect, 0.1, 0.2), { x: 0.2, y: 0.3, w: 0.2, h: 0.1 });
    near(moveRect(rect, -1, 5), { x: 0, y: 0.9, w: 0.2, h: 0.1 });
  });

  it("drag the bottom-right corner, never past the page or below the minimum", () => {
    near(resizeRect(rect, { x: 0.5, y: 0.4 }), { x: 0.1, y: 0.1, w: 0.4, h: 0.3 });
    near(resizeRect(rect, { x: 0, y: 0 }), { x: 0.1, y: 0.1, w: MIN_FIELD, h: MIN_FIELD });
  });
});

describe("nudge", () => {
  const rect = { x: 0.5, y: 0.5, w: 0.2, h: 0.1 };
  const plain = { shift: false, alt: false };

  it("moves a step per arrow key and ten with Shift", () => {
    near(nudge(rect, "ArrowRight", plain) ?? rect, { ...rect, x: 0.5 + STEP });
    near(nudge(rect, "ArrowUp", { shift: true, alt: false }) ?? rect, {
      ...rect,
      y: 0.5 - BIG_STEP,
    });
    expect(BIG_STEP).toBeCloseTo(STEP * 10, 9);
  });

  it("resizes with Alt", () => {
    near(nudge(rect, "ArrowDown", { shift: false, alt: true }) ?? rect, { ...rect, h: 0.1 + STEP });
    near(nudge(rect, "ArrowLeft", { shift: true, alt: true }) ?? rect, {
      ...rect,
      w: 0.2 - BIG_STEP,
    });
  });

  it("stops at the page edge", () => {
    near(nudge({ ...rect, x: 0.8 }, "ArrowRight", plain) ?? rect, { ...rect, x: 0.8 });
  });

  it("ignores other keys", () => {
    expect(nudge(rect, "Enter", plain)).toBeNull();
  });
});
